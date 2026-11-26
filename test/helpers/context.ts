import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { createAnswerSummarizer } from "../../src/chat/answer-summary.ts";
import { createApprovalBroker } from "../../src/chat/approval-broker.ts";
import { createChatService } from "../../src/chat/chat-service.ts";
import {
  createQueueDispatcher,
  type QueueDispatcher,
} from "../../src/chat/queue-dispatcher.ts";
import { normalizeRateLimit } from "../../src/chat/rate-limit.ts";
import { RunnerRegistry } from "../../src/chat/runner-registry.ts";
import { createClaudeStatus } from "../../src/claude/status.ts";
import { createChatRepository } from "../../src/db/chat-repository.ts";
import { createEnvironmentRepository } from "../../src/db/environment-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import { createPreferencesRepository } from "../../src/db/preferences-repository.ts";
import { createQueueRepository } from "../../src/db/queue-repository.ts";
import { createRateLimitRepository } from "../../src/db/rate-limit-repository.ts";
import { createSearchRepository } from "../../src/db/search-repository.ts";
import { createTaskRepository } from "../../src/db/task-repository.ts";
import { createWikiRepository } from "../../src/db/wiki-repository.ts";
import {
  createClaudeCode,
  type QueryFunction,
} from "../../src/provider/index.ts";
import type { RouterContext } from "../../src/router.ts";
import { createTermPageWriter } from "../../src/wiki/auto-terms.ts";
import {
  createWikiContextBuilder,
  createWikiPageReader,
} from "../../src/wiki/context.ts";
import { createWikiPageGenerator } from "../../src/wiki/page-generation.ts";
import { createWikiToolServers } from "../../src/wiki/tools.ts";

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
  const queue = createQueueRepository(opened.value.db);
  const rateLimits = createRateLimitRepository(opened.value.db);
  const onRateLimit = (info: SDKRateLimitInfo) => {
    rateLimits.save(normalizeRateLimit(info, Date.now()));
  };
  let queueDispatcher: QueueDispatcher | undefined;
  const registry = new RunnerRegistry({
    maxConcurrent: options.maxConcurrent,
  });
  const approvals = createApprovalBroker({
    onPendingChange: (chatId, count) =>
      chats.setStatus(chatId, count > 0 ? "awaiting_approval" : "running"),
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
      : createTermPageWriter({ tasks, wiki, extract: options.extract });
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
    languageModel: (modelId, { canUseTool, mcpServers }) =>
      createClaudeCode({
        cwd: "/work",
        query,
        canUseTool,
        onRateLimit,
        ...(mcpServers === undefined ? {} : { mcpServers }),
      })(modelId),
    wikiTools: createWikiToolServers({ wiki, tasks }),
    wikiContext: createWikiContextBuilder(wiki, tasks),
    readWikiPage: createWikiPageReader(wiki, tasks),
    directoriesOf: (taskId) => {
      const directories = environments.directoriesOfTask(taskId);
      return Result.isSuccess(directories) ? directories.value : undefined;
    },
    onRunnerFinish: (chatId, outcome) =>
      queueDispatcher?.onRunnerFinish(chatId, outcome),
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
  const context: RouterContext = {
    chats,
    tasks,
    environments,
    wiki,
    queue,
    queueDispatcher,
    search: createSearchRepository(opened.value.db),
    rateLimits,
    preferences: createPreferencesRepository(opened.value.db),
    chatService,
    approvals,
    claude,
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
  };
  return {
    context,
    chats,
    tasks,
    environments,
    wiki,
    queue,
    rateLimits,
    termJobs,
    summaryJobs,
    registry,
    chatService,
    approvals,
    sqlite: opened.value.sqlite,
  };
};
