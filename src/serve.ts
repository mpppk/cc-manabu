import { existsSync } from "node:fs";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { generateText } from "ai";
import {
  ANSWER_SUMMARY_MODEL,
  ANSWER_SUMMARY_SETTINGS,
  createAnswerSummarizer,
} from "./chat/answer-summary.ts";
import { createApprovalBroker } from "./chat/approval-broker.ts";
import { createChatService } from "./chat/chat-service.ts";
import {
  createQueueDispatcher,
  type QueueDispatcher,
} from "./chat/queue-dispatcher.ts";
import { normalizeRateLimit } from "./chat/rate-limit.ts";
import { RunnerRegistry } from "./chat/runner-registry.ts";
import { resolveClaudePath } from "./claude/detect.ts";
import { createClaudeStatus } from "./claude/status.ts";
import { createChatRepository } from "./db/chat-repository.ts";
import { createEnvironmentRepository } from "./db/environment-repository.ts";
import { openDatabase } from "./db/index.ts";
import { resolveDbPath } from "./db/path.ts";
import { createQueueRepository } from "./db/queue-repository.ts";
import { createRateLimitRepository } from "./db/rate-limit-repository.ts";
import { createSearchRepository } from "./db/search-repository.ts";
import { createTaskRepository } from "./db/task-repository.ts";
import { createWikiRepository } from "./db/wiki-repository.ts";
import { createDirectoryPicker } from "./environment/directory-picker.ts";
import { CliExit } from "./errors/index.ts";
import { createClaudeCode } from "./provider/index.ts";
import { router } from "./router.ts";
import type { RuntimeConfig } from "./runtime-config.ts";
import { generateToken } from "./server/access-control.ts";
import { openPwa } from "./server/open-pwa.ts";
import { openBrowser, PortInUseError, startServer } from "./server/server.ts";
import index from "./web/index.html";
import { createTermPageWriter } from "./wiki/auto-terms.ts";
import {
  createWikiContextBuilder,
  createWikiPageReader,
} from "./wiki/context.ts";
import {
  createWikiPageGenerator,
  PAGE_GENERATION_MODEL,
  PAGE_GENERATION_SETTINGS,
} from "./wiki/page-generation.ts";
import {
  TERM_EXTRACTION_MODEL,
  TERM_EXTRACTION_SETTINGS,
} from "./wiki/terms.ts";

/** DB を開いてサーバを立ち上げ、設定に応じてブラウザを開く。 */
export const serve = async (config: RuntimeConfig): Promise<void> => {
  if (config.pwa !== undefined && config.port === 0) {
    console.error(
      "--pwa には CC_MANABU_PORT が必要です。PWA をインストールしたときのポート（1〜65535）を指定してください。",
    );
    throw new CliExit({ code: 1 });
  }
  const result = Result.pipe(
    openDatabase(resolveDbPath()),
    Result.andThen(({ db }) => {
      const chats = createChatRepository(db);
      const tasks = createTaskRepository(db);
      const environments = createEnvironmentRepository(db);
      // 移行で作った、会話の無かった環境は、起動したディレクトリを使う
      environments.fillEmptyDirectories(process.cwd());
      const wiki = createWikiRepository(db);
      const queue = createQueueRepository(db);
      const rateLimits = createRateLimitRepository(db);
      const onRateLimit = (info: SDKRateLimitInfo) => {
        rateLimits.save(normalizeRateLimit(info, Date.now()));
      };
      // 前回の終了時に送信中だった予約を復元する（#102）
      queue.recover();
      const claudePath = resolveClaudePath({
        env: process.env,
        which: (command) => Bun.which(command),
        exists: existsSync,
      });
      if (Result.isFailure(claudePath)) {
        console.warn(
          "Claude Code（claude コマンド）が見つかりません。インストールしてから起動し直してください: https://docs.claude.com/en/docs/claude-code",
        );
      }
      const claude = createClaudeStatus(
        Result.isSuccess(claudePath)
          ? { found: true, path: claudePath.value }
          : { found: false, message: claudePath.error.message },
      );
      const providerSettings = {
        cwd: process.cwd(),
        onRateLimit,
        pathToClaudeCodeExecutable: Result.isSuccess(claudePath)
          ? claudePath.value
          : undefined,
      };
      const approvals = createApprovalBroker({
        onPendingChange: (chatId, count) =>
          chats.setStatus(chatId, count > 0 ? "awaiting_approval" : "running"),
      });
      // 用語抽出は Claude Code の機能を使わない軽い呼び出し（docs/spikes/term-extraction.md）
      const termModel = createClaudeCode({
        ...providerSettings,
        ...TERM_EXTRACTION_SETTINGS,
      })(TERM_EXTRACTION_MODEL);
      const writeTermPages = createTermPageWriter({
        tasks,
        wiki,
        extract: async (prompt) =>
          (await generateText({ model: termModel, prompt, reasoning: "none" }))
            .text,
      });
      // 回答の選択範囲からのページ作成も同じく軽い呼び出し
      const pageModel = createClaudeCode({
        ...providerSettings,
        ...PAGE_GENERATION_SETTINGS,
      })(PAGE_GENERATION_MODEL);
      const generateWikiPage = createWikiPageGenerator({
        tasks,
        chats,
        wiki,
        generate: async (prompt) =>
          (await generateText({ model: pageModel, prompt, reasoning: "none" }))
            .text,
        onError: (error) =>
          console.warn("Wiki のページを生成できませんでした:", error),
      });
      // 回答の要約も同じく軽い呼び出し（閉じた回答に出す）
      const summaryModel = createClaudeCode({
        ...providerSettings,
        ...ANSWER_SUMMARY_SETTINGS,
      })(ANSWER_SUMMARY_MODEL);
      const summarizeAnswer = createAnswerSummarizer({
        chats,
        summarize: async (prompt) =>
          (
            await generateText({
              model: summaryModel,
              prompt,
              reasoning: "none",
            })
          ).text,
      });
      const registry = new RunnerRegistry();
      let queueDispatcher: QueueDispatcher | undefined;
      const chatService = createChatService({
        chats,
        registry,
        approvals,
        languageModel: (modelId, { canUseTool }) =>
          createClaudeCode({ ...providerSettings, canUseTool })(modelId),
        wikiContext: createWikiContextBuilder(wiki, tasks),
        readWikiPage: createWikiPageReader(wiki, tasks),
        directoriesOf: (taskId) => {
          const directories = environments.directoriesOfTask(taskId);
          return Result.isSuccess(directories) ? directories.value : undefined;
        },
        onAnswerComplete: (event) => void writeTermPages(event),
        onAnswerFinish: (event) => void summarizeAnswer(event),
        onRunnerFinish: (chatId, outcome) =>
          queueDispatcher?.onRunnerFinish(chatId, outcome),
      });
      queueDispatcher = createQueueDispatcher({
        queue,
        registry,
        chatService,
      });
      return startServer({
        port: config.port,
        token: config.requireToken ? generateToken() : null,
        router,
        index,
        development: process.env.NODE_ENV !== "production",
        context: {
          chats,
          tasks,
          environments,
          wiki,
          queue,
          queueDispatcher,
          search: createSearchRepository(db),
          rateLimits,
          chatService,
          approvals,
          claude,
          generateWikiPage,
          cwd: process.cwd(),
          pickDirectory: createDirectoryPicker(),
        },
      });
    }),
  );
  if (Result.isFailure(result)) {
    console.error(
      result.error instanceof PortInUseError && config.pwa !== undefined
        ? `ポート ${config.port} は使用中です。インストール時と同じポートを空けてから再実行してください。`
        : result.error.message,
    );
    throw new CliExit({ code: 1 });
  }
  const server = result.value;
  if (!config.requireToken) {
    console.warn(
      "警告: CC_MANABU_NO_AUTH=1 のため、アクセストークンなしで API を呼べます（デバッグ用）。このマシンの他のプロセスやユーザーからも、Claude にファイル編集やコマンド実行をさせられます。",
    );
  }
  console.log(`cc-manabu を起動しました: ${server.url}`);
  console.log("終了するには Ctrl+C を押してください。");
  if (!config.openBrowser) return;
  if (config.pwa !== undefined) {
    const launch = await openPwa(server.url, config.pwa);
    if (Result.isSuccess(launch)) return;
    console.warn(
      `PWA を開けませんでした。 ${launch.error.message} 通常のブラウザで開きます。`,
    );
  }
  openBrowser(server.url);
};
