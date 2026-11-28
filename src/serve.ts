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
import { createSessionSync } from "./chat/session-sync.ts";
import { createTaskContextBuilder } from "./chat/task-context.ts";
import {
  createWikiThreadTitler,
  THREAD_TITLE_MODEL,
  THREAD_TITLE_SETTINGS,
} from "./chat/thread-title.ts";
import { resolveClaudePath } from "./claude/detect.ts";
import { createDesktopLauncher, sdkSessionReader } from "./claude/sessions.ts";
import { createClaudeStatus } from "./claude/status.ts";
import { createChatRepository } from "./db/chat-repository.ts";
import { createEnvironmentRepository } from "./db/environment-repository.ts";
import { createGoalRunRepository } from "./db/goal-run-repository.ts";
import { openDatabase } from "./db/index.ts";
import { resolveDbPath } from "./db/path.ts";
import { createPreferencesRepository } from "./db/preferences-repository.ts";
import { createQueueRepository } from "./db/queue-repository.ts";
import { createRateLimitRepository } from "./db/rate-limit-repository.ts";
import { createSearchRepository } from "./db/search-repository.ts";
import { createTaskRepository } from "./db/task-repository.ts";
import { createWikiHistoryRepository } from "./db/wiki-history-repository.ts";
import { createWikiRepository } from "./db/wiki-repository.ts";
import { readEnv } from "./env.ts";
import { createDirectoryPicker } from "./environment/directory-picker.ts";
import { CliExit } from "./errors/index.ts";
import { createClaudeCode } from "./provider/index.ts";
import { router } from "./router.ts";
import type { RuntimeConfig } from "./runtime-config.ts";
import { generateToken } from "./server/access-control.ts";
import {
  createAnswerNotifier,
  notifyWithOsascript,
} from "./server/answer-notification.ts";
import {
  findInstalledPwa,
  type InstalledPwa,
  openPwa,
} from "./server/open-pwa.ts";
import { closePwaOnExit, trackPwaWindow } from "./server/pwa-window.ts";
import { openBrowser, PortInUseError, startServer } from "./server/server.ts";
import { createGoalRuns, type GoalRuns } from "./task/goal-runs.ts";
import { readGoalVerdict } from "./task/goal-verdict.ts";
import { createTaskToolServers } from "./task/tools.ts";
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
  createPageQaWriter,
  PAGE_QA_MODEL,
  PAGE_QA_SETTINGS,
} from "./wiki/page-qa.ts";
import {
  TERM_EXTRACTION_MODEL,
  TERM_EXTRACTION_SETTINGS,
} from "./wiki/terms.ts";
import { createWikiToolServers } from "./wiki/tools.ts";

/** DB を開いてサーバを立ち上げ、設定に応じてブラウザを開く。 */
export const serve = async (config: RuntimeConfig): Promise<void> => {
  if (config.pwa !== undefined && config.port === 0) {
    console.error(
      "--pwa には MONET_PORT が必要です。PWA をインストールしたときのポート（1〜65535）を指定してください。",
    );
    throw new CliExit({ code: 1 });
  }
  // --pwa が無くても、インストール済みの PWA があればそのポートで起動して開く（#163）
  let installedPwa: InstalledPwa | undefined;
  if (config.openBrowser && config.pwa === undefined) {
    const found = findInstalledPwa({ port: config.port, ...config.chrome });
    if (Result.isSuccess(found)) {
      installedPwa = found.value;
    } else {
      console.warn(`${found.error.message} 通常のブラウザで開きます。`);
    }
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
      const wikiHistory = createWikiHistoryRepository(db);
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
      // ゴールの実行（#198）。送信に chatService を使うので、あとで作る
      let goalRuns: GoalRuns | undefined;
      const approvals = createApprovalBroker({
        onPendingChange: (chatId, count) => {
          chats.setStatus(chatId, count > 0 ? "awaiting_approval" : "running");
          goalRuns?.onPendingChange(chatId, count);
        },
      });
      // 用語抽出は Claude Code の機能を使わない軽い呼び出し（docs/spikes/term-extraction.md）
      const termModel = createClaudeCode({
        ...providerSettings,
        ...TERM_EXTRACTION_SETTINGS,
      })(TERM_EXTRACTION_MODEL);
      const writeTermPages = createTermPageWriter({
        tasks,
        wiki,
        descriptionOf: (taskId) => {
          const description = environments.descriptionOfTask(taskId);
          return Result.isSuccess(description) ? description.value : undefined;
        },
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
        readWikiPage: createWikiPageReader(wiki, tasks),
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
      // Wiki ページから始めたスレッドのタイトルも同じく軽い呼び出し（#161）
      const threadTitleModel = createClaudeCode({
        ...providerSettings,
        ...THREAD_TITLE_SETTINGS,
      })(THREAD_TITLE_MODEL);
      const wikiThreadTitler = createWikiThreadTitler({
        chats,
        generate: async (prompt) =>
          (
            await generateText({
              model: threadTitleModel,
              prompt,
              reasoning: "none",
            })
          ).text,
      });
      // Wiki ページへの質問と回答からの Q&A も同じく軽い呼び出し（#159）
      const pageQaModel = createClaudeCode({
        ...providerSettings,
        ...PAGE_QA_SETTINGS,
      })(PAGE_QA_MODEL);
      const writePageQa = createPageQaWriter({
        chats,
        wiki,
        generate: async (prompt) =>
          (
            await generateText({
              model: pageQaModel,
              prompt,
              reasoning: "none",
            })
          ).text,
      });
      // 回答が完了したら Mac に通知する（#264）。MONET_NO_NOTIFY=1 で止められる
      const notifyAnswer =
        process.platform === "darwin" &&
        readEnv(process.env, "NO_NOTIFY") !== "1"
          ? createAnswerNotifier({
              chats,
              notify: notifyWithOsascript,
              onError: (error) =>
                console.warn(
                  `回答の完了を通知できませんでした: ${error.message}`,
                ),
            })
          : undefined;
      const registry = new RunnerRegistry();
      let queueDispatcher: QueueDispatcher | undefined;
      const chatService = createChatService({
        chats,
        registry,
        approvals,
        languageModel: (modelId, options) =>
          createClaudeCode({ ...providerSettings, ...options })(modelId),
        taskTools: createTaskToolServers({ tasks }),
        wikiTools: createWikiToolServers({
          wiki,
          tasks,
          history: wikiHistory,
        }),
        onWikiBatchFinish: (batchId, messageId) =>
          wikiHistory.attachAnswer(batchId, messageId),
        wikiContext: createWikiContextBuilder(wiki, tasks),
        taskContext: createTaskContextBuilder(tasks, environments),
        readWikiPage: createWikiPageReader(wiki, tasks),
        directoriesOf: (taskId) => {
          const directories = environments.directoriesOfTask(taskId);
          return Result.isSuccess(directories) ? directories.value : undefined;
        },
        onAnswerComplete: (event) => void writeTermPages(event),
        onAnswerFinish: (event) => {
          void summarizeAnswer(event);
          void wikiThreadTitler.onAnswerFinish(event);
          void writePageQa(event);
        },
        onAnswerSaved: (event) => void notifyAnswer?.(event),
        onWikiChatCreated: (chat) => wikiThreadTitler.track(chat),
        onRunnerStart: (chatId) => goalRuns?.onRunnerStart(chatId),
        onRunnerFinish: (chatId, outcome) => {
          queueDispatcher?.onRunnerFinish(chatId, outcome);
          void goalRuns?.onRunnerFinish(chatId, outcome);
        },
      });
      const preferences = createPreferencesRepository(db);
      goalRuns = createGoalRuns({
        tasks,
        chats,
        environments,
        goalRuns: createGoalRunRepository(db),
        preferences,
        chatService,
        readVerdict: readGoalVerdict,
        cwd: process.cwd(),
      });
      const goalRunService = goalRuns;
      queueDispatcher = createQueueDispatcher({
        queue,
        registry,
        chatService,
      });
      const start = (port: number) =>
        startServer({
          port,
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
            preferences,
            goalRuns: goalRunService,
            wikiHistory,
            chatService,
            approvals,
            claude,
            generateWikiPage,
            cwd: process.cwd(),
            pickDirectory: createDirectoryPicker(),
            sessionSync: createSessionSync({
              chats,
              reader: sdkSessionReader,
              launchDesktop: createDesktopLauncher(
                Result.isSuccess(claudePath) ? claudePath.value : undefined,
              ),
            }),
          },
        });
      const port = installedPwa?.port ?? config.port;
      const started = start(port);
      // 自動で見つけた PWA のポートが使用中なら、PWA は使わずに空いているポートで起動する
      if (
        Result.isFailure(started) &&
        started.error instanceof PortInUseError &&
        installedPwa !== undefined &&
        config.port === 0
      ) {
        console.warn(
          `PWA をインストールしたポート ${port} は使用中です。PWA を使わずに起動します。PWA を使うには、そのポートを空けてから再実行してください。`,
        );
        installedPwa = undefined;
        return start(0);
      }
      return started;
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
      "警告: MONET_NO_AUTH=1 のため、アクセストークンなしで API を呼べます（デバッグ用）。このマシンの他のプロセスやユーザーからも、Claude にファイル編集やコマンド実行をさせられます。",
    );
  }
  console.log(`monet を起動しました: ${server.url}`);
  console.log("終了するには Ctrl+C を押してください。");
  if (!config.openBrowser) return;
  const pwa =
    config.pwa ??
    (installedPwa === undefined
      ? undefined
      : { profile: installedPwa.profile, appId: installedPwa.appId });
  if (pwa !== undefined) {
    // 起動前のウィンドウを覚えておき、今回開いた PWA のウィンドウを Ctrl+C で閉じる（#182）
    const tracker =
      process.platform === "darwin"
        ? await trackPwaWindow(new URL("/", server.url).href)
        : undefined;
    const launch = await openPwa(server.url, pwa);
    if (Result.isSuccess(launch)) {
      if (tracker !== undefined) {
        void tracker.findLaunched();
        closePwaOnExit(tracker);
      }
      return;
    }
    console.warn(
      `PWA を開けませんでした。 ${launch.error.message} 通常のブラウザで開きます。`,
    );
  }
  openBrowser(server.url);
};
