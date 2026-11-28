import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import type { AgentStatuses } from "../../src/agents/status.ts";
import { createAnswerSummarizer } from "../../src/chat/answer-summary.ts";
import { createApprovalBroker } from "../../src/chat/approval-broker.ts";
import { createChatService } from "../../src/chat/chat-service.ts";
import {
  createQueueDispatcher,
  type QueueDispatcher,
} from "../../src/chat/queue-dispatcher.ts";
import { normalizeRateLimit } from "../../src/chat/rate-limit.ts";
import { RunnerRegistry } from "../../src/chat/runner-registry.ts";
import { createSessionSync } from "../../src/chat/session-sync.ts";
import { createTaskContextBuilder } from "../../src/chat/task-context.ts";
import { createClaudeStatus } from "../../src/claude/status.ts";
import { createChatRepository } from "../../src/db/chat-repository.ts";
import { createEnvironmentRepository } from "../../src/db/environment-repository.ts";
import { createGoalRunRepository } from "../../src/db/goal-run-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import { createPreferencesRepository } from "../../src/db/preferences-repository.ts";
import { createQueueRepository } from "../../src/db/queue-repository.ts";
import { createRateLimitRepository } from "../../src/db/rate-limit-repository.ts";
import { createSearchRepository } from "../../src/db/search-repository.ts";
import { createTaskRepository } from "../../src/db/task-repository.ts";
import { createWikiHistoryRepository } from "../../src/db/wiki-history-repository.ts";
import { createWikiRepository } from "../../src/db/wiki-repository.ts";
import {
  createClaudeCode,
  type QueryFunction,
} from "../../src/provider/index.ts";
import type { RouterContext } from "../../src/router.ts";
import { createGoalRuns, type GoalRuns } from "../../src/task/goal-runs.ts";
import type { GoalVerdictReader } from "../../src/task/goal-verdict.ts";
import { createTaskToolServers } from "../../src/task/tools.ts";
import { createTermPageWriter } from "../../src/wiki/auto-terms.ts";
import {
  createWikiContextBuilder,
  createWikiPageReader,
} from "../../src/wiki/context.ts";
import { createWikiPageGenerator } from "../../src/wiki/page-generation.ts";
import { createWikiToolServers } from "../../src/wiki/tools.ts";
import { createFakeSessions } from "./fake-sessions.ts";

/** テストでの Claude Code 以外の AI の状態（#265）。 */
export const TEST_AGENTS: AgentStatuses = {
  codex: {
    state: "ready",
    models: [
      {
        value: "gpt-test",
        displayName: "GPT Test",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
      },
    ],
  },
  copilot: {
    state: "unavailable",
    reason: "GitHub Copilot CLI（`copilot`）が見つかりません。",
    setup: ["GitHub Copilot CLI をインストールする"],
  },
};

/**
 * インメモリ DB と、差し替えた query() を使うルータのコンテキストを作る。
 * query を省略すると、呼ばれたら例外にする。
 */
export const createTestContext = (
  options: {
    query?: QueryFunction;
    maxConcurrent?: number;
    /** 用語抽出のモデル呼び出し。指定すると回答後に用語ページを作る（#80）。 */
    extract?: (prompt: string) => Promise<string>;
    /** 回答の要約のモデル呼び出し。指定すると回答後に要約を作る。 */
    summarize?: (prompt: string) => Promise<string>;
    /** フォルダを選ぶダイアログ。省略するとキャンセルした扱い。 */
    pickDirectory?: RouterContext["pickDirectory"];
    /** 選択範囲からのページ生成のモデル呼び出し。省略すると、呼ばれたら失敗する。 */
    generatePage?: (prompt: string) => Promise<string>;
    /**
     * タスクと環境の情報を参照情報として渡す（#186）。既定では渡さない
     * （ほかのテストが送ったプロンプトをそのまま比べられるように）。
     */
    taskContext?: boolean;
    /** `/goal` の評価の読み取り（#198）。省略すると判定なし。 */
    readVerdict?: GoalVerdictReader;
    /** 回答のあとにコンテキストの使用量を取る（#245）。既定では取らない。 */
    contextUsage?: boolean;
    /** 回答が正常に終わって保存されたとき（#264）。 */
    onAnswerSaved?: (event: { chatId: string; messageId: string }) => void;
    /** Claude Code 以外の AI の状態（#265）。既定では Codex を使え、Copilot は未導入。 */
    agents?: AgentStatuses;
  } = {},
) => {
  const opened = openDatabase(":memory:");
  if (Result.isFailure(opened)) {
    throw opened.error;
  }
  const chats = createChatRepository(opened.value.db);
  const tasks = createTaskRepository(opened.value.db);
  const environments = createEnvironmentRepository(opened.value.db);
  const wiki = createWikiRepository(opened.value.db);
  const wikiHistory = createWikiHistoryRepository(opened.value.db);
  const queue = createQueueRepository(opened.value.db);
  const rateLimits = createRateLimitRepository(opened.value.db);
  const onRateLimit = (info: SDKRateLimitInfo) => {
    rateLimits.save(normalizeRateLimit(info, Date.now()));
  };
  let queueDispatcher: QueueDispatcher | undefined;
  let goalRuns: GoalRuns | undefined;
  const registry = new RunnerRegistry({
    maxConcurrent: options.maxConcurrent,
  });
  const approvals = createApprovalBroker({
    onPendingChange: (chatId, count) => {
      chats.setStatus(chatId, count > 0 ? "awaiting_approval" : "running");
      goalRuns?.onPendingChange(chatId, count);
    },
  });
  const query: QueryFunction =
    options.query ??
    (() => {
      throw new Error("query is not configured in this test");
    });
  /** 回答後に走った用語ページ作成（テストで完了を待つ）。 */
  const termJobs: Promise<unknown>[] = [];
  const writeTermPages =
    options.extract === undefined
      ? undefined
      : createTermPageWriter({
          tasks,
          wiki,
          extract: options.extract,
          descriptionOf: (taskId) => {
            const description = environments.descriptionOfTask(taskId);
            return Result.isSuccess(description)
              ? description.value
              : undefined;
          },
        });
  /** 回答後に走った要約（テストで完了を待つ）。 */
  const summaryJobs: Promise<unknown>[] = [];
  const summarizeAnswer =
    options.summarize === undefined
      ? undefined
      : createAnswerSummarizer({ chats, summarize: options.summarize });
  const chatService = createChatService({
    chats,
    registry,
    approvals,
    // Codex の会話も、差し替えた query() で答える（AI ごとの違いは provider のテストで確かめる）
    languageModel: (modelId, { canUseTool, mcpServers, onContextUsage }) =>
      createClaudeCode({
        cwd: "/work",
        query,
        canUseTool,
        onRateLimit,
        ...(mcpServers === undefined ? {} : { mcpServers }),
        // 入力を開けておく形になるので、使うテストだけで有効にする（#245）
        ...(options.contextUsage === true && onContextUsage !== undefined
          ? { onContextUsage }
          : {}),
      })(modelId),
    taskTools: createTaskToolServers({ tasks }),
    wikiTools: createWikiToolServers({ wiki, tasks, history: wikiHistory }),
    onWikiBatchFinish: (batchId, messageId) =>
      wikiHistory.attachAnswer(batchId, messageId),
    wikiContext: createWikiContextBuilder(wiki, tasks),
    ...(options.taskContext === true
      ? { taskContext: createTaskContextBuilder(tasks, environments) }
      : {}),
    readWikiPage: createWikiPageReader(wiki, tasks),
    directoriesOf: (taskId) => {
      const directories = environments.directoriesOfTask(taskId);
      return Result.isSuccess(directories) ? directories.value : undefined;
    },
    onRunnerStart: (chatId) => goalRuns?.onRunnerStart(chatId),
    onRunnerFinish: (chatId, outcome) => {
      queueDispatcher?.onRunnerFinish(chatId, outcome);
      void goalRuns?.onRunnerFinish(chatId, outcome);
    },
    ...(options.onAnswerSaved === undefined
      ? {}
      : { onAnswerSaved: options.onAnswerSaved }),
    ...(writeTermPages === undefined
      ? {}
      : {
          onAnswerComplete: (event) => {
            termJobs.push(writeTermPages(event));
          },
        }),
    ...(summarizeAnswer === undefined
      ? {}
      : {
          onAnswerFinish: (event) => {
            summaryJobs.push(summarizeAnswer(event));
          },
        }),
  });
  queueDispatcher = createQueueDispatcher({ queue, registry, chatService });
  const preferences = createPreferencesRepository(opened.value.db);
  goalRuns = createGoalRuns({
    tasks,
    chats,
    environments,
    goalRuns: createGoalRunRepository(opened.value.db),
    preferences,
    chatService,
    readVerdict:
      options.readVerdict ?? (async () => ({ kind: "none", reason: "" })),
    cwd: "/work",
  });
  const goalRunService = goalRuns;
  const claude = createClaudeStatus(
    { found: true, path: "/usr/local/bin/claude" },
    {
      version: async () => "2.1.330",
      probe: async () =>
        Result.succeed({
          models: [
            {
              value: "default",
              displayName: "Default",
              description: "",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high"],
            },
          ],
          account: { subscriptionType: "Claude Max" },
        }),
    },
  );
  const sessions = createFakeSessions(chats);
  const context: RouterContext = {
    chats,
    tasks,
    environments,
    wiki,
    queue,
    queueDispatcher,
    search: createSearchRepository(opened.value.db),
    rateLimits,
    preferences,
    goalRuns: goalRunService,
    wikiHistory,
    chatService,
    approvals,
    claude,
    agents: {
      get: () => options.agents ?? TEST_AGENTS,
      ready: Promise.resolve(),
    },
    generateWikiPage: createWikiPageGenerator({
      tasks,
      chats,
      wiki,
      readWikiPage: createWikiPageReader(wiki, tasks),
      generate:
        options.generatePage ??
        (() => {
          throw new Error("generatePage is not configured in this test");
        }),
    }),
    cwd: "/work",
    pickDirectory:
      options.pickDirectory ??
      (async () => Result.succeed<string | null>(null)),
    sessionSync: createSessionSync({
      chats,
      reader: sessions.reader,
      launchDesktop: sessions.launchDesktop,
    }),
  };
  return {
    context,
    chats,
    tasks,
    environments,
    wiki,
    wikiHistory,
    queue,
    rateLimits,
    termJobs,
    summaryJobs,
    registry,
    chatService,
    approvals,
    sessions,
    sqlite: opened.value.sqlite,
  };
};
