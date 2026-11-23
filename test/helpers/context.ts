import { Result } from "@praha/byethrow";
import { createApprovalBroker } from "../../src/chat/approval-broker.ts";
import { createChatService } from "../../src/chat/chat-service.ts";
import { RunnerRegistry } from "../../src/chat/runner-registry.ts";
import { createClaudeStatus } from "../../src/claude/status.ts";
import { createChatRepository } from "../../src/db/chat-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import { createProjectRepository } from "../../src/db/project-repository.ts";
import { createWikiRepository } from "../../src/db/wiki-repository.ts";
import {
  createClaudeCode,
  type QueryFunction,
} from "../../src/provider/index.ts";
import type { RouterContext } from "../../src/router.ts";
import { createTermPageWriter } from "../../src/wiki/auto-terms.ts";
import { createWikiContextBuilder } from "../../src/wiki/context.ts";

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
  const projects = createProjectRepository(opened.value.db);
  const wiki = createWikiRepository(opened.value.db);
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
      : createTermPageWriter({ projects, wiki, extract: options.extract });
  const chatService = createChatService({
    chats,
    registry,
    approvals,
    languageModel: (modelId, { canUseTool }) =>
      createClaudeCode({ cwd: "/work", query, canUseTool })(modelId),
    wikiContext: createWikiContextBuilder(wiki),
    ...(writeTermPages === undefined
      ? {}
      : {
          onAnswerComplete: (event) => {
            termJobs.push(writeTermPages(event));
          },
        }),
  });
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
    projects,
    wiki,
    chatService,
    approvals,
    claude,
    cwd: "/work",
  };
  return {
    context,
    chats,
    projects,
    wiki,
    termJobs,
    registry,
    chatService,
    approvals,
    sqlite: opened.value.sqlite,
  };
};
