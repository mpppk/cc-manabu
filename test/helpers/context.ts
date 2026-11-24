import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
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
import { openDatabase } from "../../src/db/index.ts";
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
  } = {},
) => {
  const opened = openDatabase(":memory:");
  if (Result.isFailure(opened)) {
    throw opened.error;
  }
  const chats = createChatRepository(opened.value.db);
  const tasks = createTaskRepository(opened.value.db);
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
  const chatService = createChatService({
    chats,
    registry,
    approvals,
    languageModel: (modelId, { canUseTool }) =>
      createClaudeCode({ cwd: "/work", query, canUseTool, onRateLimit })(
        modelId,
      ),
    wikiContext: createWikiContextBuilder(wiki, tasks),
    readWikiPage: createWikiPageReader(wiki, tasks),
    onRunnerFinish: (chatId, outcome) =>
      queueDispatcher?.onRunnerFinish(chatId, outcome),
    ...(writeTermPages === undefined
      ? {}
      : {
          onAnswerComplete: (event) => {
            termJobs.push(writeTermPages(event));
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
    wiki,
    queue,
    queueDispatcher,
    search: createSearchRepository(opened.value.db),
    rateLimits,
    chatService,
    approvals,
    claude,
    cwd: "/work",
  };
  return {
    context,
    chats,
    tasks,
    wiki,
    queue,
    rateLimits,
    termJobs,
    registry,
    chatService,
    approvals,
    sqlite: opened.value.sqlite,
  };
};
