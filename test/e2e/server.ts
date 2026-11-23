#!/usr/bin/env bun
/**
 * E2E テスト用のサーバ。インメモリ DB と台本どおりに応答するモック query() で、本物の UI を配信する。
 *
 *   bun test/e2e/server.ts   （playwright.config.ts の webServer から起動される）
 */
import { Result } from "@praha/byethrow";
import { generateText } from "ai";
import { createApprovalBroker } from "../../src/chat/approval-broker.ts";
import { createChatService } from "../../src/chat/chat-service.ts";
import { RunnerRegistry } from "../../src/chat/runner-registry.ts";
import { createClaudeStatus } from "../../src/claude/status.ts";
import { createChatRepository } from "../../src/db/chat-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import { createProjectRepository } from "../../src/db/project-repository.ts";
import { createWikiRepository } from "../../src/db/wiki-repository.ts";
import { createClaudeCode } from "../../src/provider/index.ts";
import { router } from "../../src/router.ts";
import { startServer } from "../../src/server/server.ts";
import index from "../../src/web/index.html";
import { createTermPageWriter } from "../../src/wiki/auto-terms.ts";
import { createWikiContextBuilder } from "../../src/wiki/context.ts";
import {
  TERM_EXTRACTION_MODEL,
  TERM_EXTRACTION_SETTINGS,
} from "../../src/wiki/terms.ts";
import { createScriptedQuery } from "./scripted-query.ts";

export const E2E_PORT = Number(process.env.E2E_PORT ?? 45200);
export const E2E_TOKEN = "e2e-token";

const opened = openDatabase(":memory:");
if (Result.isFailure(opened)) throw opened.error;
const chats = createChatRepository(opened.value.db);
const projects = createProjectRepository(opened.value.db);
const wiki = createWikiRepository(opened.value.db);
const approvals = createApprovalBroker({
  onPendingChange: (chatId, count) =>
    chats.setStatus(chatId, count > 0 ? "awaiting_approval" : "running"),
});
const query = createScriptedQuery();
const termModel = createClaudeCode({
  cwd: "/e2e",
  query,
  ...TERM_EXTRACTION_SETTINGS,
})(TERM_EXTRACTION_MODEL);
const writeTermPages = createTermPageWriter({
  projects,
  wiki,
  extract: async (prompt) =>
    (await generateText({ model: termModel, prompt })).text,
});
const chatService = createChatService({
  chats,
  registry: new RunnerRegistry(),
  approvals,
  languageModel: (modelId, { canUseTool }) =>
    createClaudeCode({ cwd: "/e2e", query, canUseTool })(modelId),
  wikiContext: createWikiContextBuilder(wiki),
  onAnswerComplete: (event) => void writeTermPages(event),
});
const claude = createClaudeStatus(
  { found: true, path: "/usr/local/bin/claude" },
  {
    version: async () => "0.0.0-e2e",
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
          { value: "haiku", displayName: "Haiku", description: "" },
        ],
        account: { subscriptionType: "E2E" },
      }),
  },
);

const started = startServer({
  port: E2E_PORT,
  token: E2E_TOKEN,
  router,
  index,
  context: {
    chats,
    projects,
    wiki,
    chatService,
    approvals,
    claude,
    cwd: "/e2e",
  },
});
if (Result.isFailure(started)) throw started.error;
console.log(`e2e server: ${started.value.url}`);
