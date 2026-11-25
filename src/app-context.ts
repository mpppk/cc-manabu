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
import { createClaudeStatus } from "./claude/status.ts";
import { createChatRepository } from "./db/chat-repository.ts";
import { createEnvironmentRepository } from "./db/environment-repository.ts";
import type { Db } from "./db/index.ts";
import { createQueueRepository } from "./db/queue-repository.ts";
import { createRateLimitRepository } from "./db/rate-limit-repository.ts";
import { createSearchRepository } from "./db/search-repository.ts";
import { createTaskRepository } from "./db/task-repository.ts";
import { createWikiRepository } from "./db/wiki-repository.ts";
import type { DirectoryNormalizer } from "./environment/directories.ts";
import type { DirectoryPicker } from "./environment/directory-picker.ts";
import { createClaudeCode } from "./provider/index.ts";
import type { ClaudeCodeProviderSettings } from "./provider/types.ts";
import type { RouterContext } from "./router.ts";
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

/** router の context を組み立てるのに要るもの。CLI（serve.ts）とデスクトップアプリ版で中身が違う。 */
export type AppContextDeps = {
  db: Db;
  /** タスクに属さない会話の作業ディレクトリ（CLI は起動したディレクトリ）。 */
  cwd: string;
  /** `claude` が見つかったか。 */
  claude: { found: true; path: string } | { found: false; message: string };
  /** Claude Code の状態の調べ方（バージョンとモデル一覧）。省略時は Agent SDK を使う。 */
  claudeStatus?: Parameters<typeof createClaudeStatus>[1];
  /** Provider の追加設定。デスクトップアプリ版は query を差し替える。 */
  provider?: Pick<ClaudeCodeProviderSettings, "query" | "env">;
  pickDirectory: DirectoryPicker;
  normalizeDirectories: DirectoryNormalizer;
  /** Wiki のページ生成に失敗したときなど、利用者に見せない警告。 */
  warn?: (message: string, error: unknown) => void;
};

/** DB と環境ごとの依存から、リポジトリ・承認・生成・キューをつないだ router の context を作る。 */
export const createAppContext = (deps: AppContextDeps): RouterContext => {
  const { db, cwd } = deps;
  const warn = deps.warn ?? ((message, error) => console.warn(message, error));
  const chats = createChatRepository(db);
  const tasks = createTaskRepository(db);
  const environments = createEnvironmentRepository(db);
  // 移行で作った、会話の無かった環境は、起動したディレクトリを使う
  environments.fillEmptyDirectories(cwd);
  const wiki = createWikiRepository(db);
  const queue = createQueueRepository(db);
  const rateLimits = createRateLimitRepository(db);
  const onRateLimit = (info: SDKRateLimitInfo) => {
    rateLimits.save(normalizeRateLimit(info, Date.now()));
  };
  // 前回の終了時に送信中だった予約を復元する（#102）
  queue.recover();
  const claude = createClaudeStatus(deps.claude, deps.claudeStatus);
  const providerSettings: ClaudeCodeProviderSettings = {
    cwd,
    onRateLimit,
    ...(deps.claude.found
      ? { pathToClaudeCodeExecutable: deps.claude.path }
      : {}),
    ...deps.provider,
  };
  const approvals = createApprovalBroker({
    onPendingChange: (chatId, count) =>
      chats.setStatus(chatId, count > 0 ? "awaiting_approval" : "running"),
  });
  /** Claude Code の機能を使わない軽い呼び出し（用語抽出・ページ作成・要約）。 */
  const lightText =
    (model: ReturnType<ReturnType<typeof createClaudeCode>>) =>
    async (prompt: string) =>
      (await generateText({ model, prompt, reasoning: "none" })).text;
  // 用語抽出（docs/spikes/term-extraction.md）
  const writeTermPages = createTermPageWriter({
    tasks,
    wiki,
    extract: lightText(
      createClaudeCode({ ...providerSettings, ...TERM_EXTRACTION_SETTINGS })(
        TERM_EXTRACTION_MODEL,
      ),
    ),
  });
  // 回答の選択範囲からのページ作成
  const generateWikiPage = createWikiPageGenerator({
    tasks,
    chats,
    wiki,
    generate: lightText(
      createClaudeCode({ ...providerSettings, ...PAGE_GENERATION_SETTINGS })(
        PAGE_GENERATION_MODEL,
      ),
    ),
    onError: (error) => warn("Wiki のページを生成できませんでした:", error),
  });
  // 回答の要約（閉じた回答に出す）
  const summarizeAnswer = createAnswerSummarizer({
    chats,
    summarize: lightText(
      createClaudeCode({ ...providerSettings, ...ANSWER_SUMMARY_SETTINGS })(
        ANSWER_SUMMARY_MODEL,
      ),
    ),
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
  queueDispatcher = createQueueDispatcher({ queue, registry, chatService });
  return {
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
    cwd,
    pickDirectory: deps.pickDirectory,
    normalizeDirectories: deps.normalizeDirectories,
  };
};
