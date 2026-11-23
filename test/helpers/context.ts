import { Result } from "@praha/byethrow";
import { createApprovalBroker } from "../../src/chat/approval-broker.ts";
import { createChatService } from "../../src/chat/chat-service.ts";
import { RunnerRegistry } from "../../src/chat/runner-registry.ts";
import { createChatRepository } from "../../src/db/chat-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import {
  createClaudeCode,
  type QueryFunction,
} from "../../src/provider/index.ts";
import type { RouterContext } from "../../src/router.ts";

/**
 * インメモリ DB と、差し替えた query() を使うルータのコンテキストを作る。
 * query を省略すると、呼ばれたら例外にする。
 */
export const createTestContext = (
  options: { query?: QueryFunction; maxConcurrent?: number } = {},
) => {
  const opened = openDatabase(":memory:");
  if (Result.isFailure(opened)) {
    throw opened.error;
  }
  const chats = createChatRepository(opened.value.db);
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
  const chatService = createChatService({
    chats,
    registry,
    approvals,
    languageModel: (modelId, { canUseTool }) =>
      createClaudeCode({ cwd: "/work", query, canUseTool })(modelId),
  });
  const context: RouterContext = {
    chats,
    chatService,
    approvals,
    cwd: "/work",
  };
  return {
    context,
    chats,
    registry,
    chatService,
    approvals,
    sqlite: opened.value.sqlite,
  };
};
