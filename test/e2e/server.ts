#!/usr/bin/env bun

/**
 * E2E テスト用のサーバ。インメモリ DB と台本どおりに応答するモック query() で、本物の UI を配信する。
 *
 *   bun test/e2e/server.ts   （playwright.config.ts の webServer から起動される）
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { generateText } from "ai";
import {
  ANSWER_SUMMARY_MODEL,
  ANSWER_SUMMARY_SETTINGS,
  createAnswerSummarizer,
} from "../../src/chat/answer-summary.ts";
import { createApprovalBroker } from "../../src/chat/approval-broker.ts";
import { createChatService } from "../../src/chat/chat-service.ts";
import {
  createQueueDispatcher,
  type QueueDispatcher,
} from "../../src/chat/queue-dispatcher.ts";
import { normalizeRateLimit } from "../../src/chat/rate-limit.ts";
import { RunnerRegistry } from "../../src/chat/runner-registry.ts";
import { createTaskContextBuilder } from "../../src/chat/task-context.ts";
import {
  createWikiThreadTitler,
  THREAD_TITLE_MODEL,
  THREAD_TITLE_SETTINGS,
} from "../../src/chat/thread-title.ts";
import { createClaudeStatus } from "../../src/claude/status.ts";
import { createChatRepository } from "../../src/db/chat-repository.ts";
import { createEnvironmentRepository } from "../../src/db/environment-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import { createPreferencesRepository } from "../../src/db/preferences-repository.ts";
import { createQueueRepository } from "../../src/db/queue-repository.ts";
import { createRateLimitRepository } from "../../src/db/rate-limit-repository.ts";
import { createSearchRepository } from "../../src/db/search-repository.ts";
import { createTaskRepository } from "../../src/db/task-repository.ts";
import { createWikiHistoryRepository } from "../../src/db/wiki-history-repository.ts";
import { createWikiRepository } from "../../src/db/wiki-repository.ts";
import { createClaudeCode } from "../../src/provider/index.ts";
import { router } from "../../src/router.ts";
import { startServer } from "../../src/server/server.ts";
import { createTaskToolServers } from "../../src/task/tools.ts";
import index from "../../src/web/index.html";
import { createTermPageWriter } from "../../src/wiki/auto-terms.ts";
import {
  createWikiContextBuilder,
  createWikiPageReader,
} from "../../src/wiki/context.ts";
import {
  createWikiPageGenerator,
  PAGE_GENERATION_MODEL,
  PAGE_GENERATION_SETTINGS,
} from "../../src/wiki/page-generation.ts";
import {
  createPageQaWriter,
  PAGE_QA_MODEL,
  PAGE_QA_SETTINGS,
} from "../../src/wiki/page-qa.ts";
import {
  TERM_EXTRACTION_MODEL,
  TERM_EXTRACTION_SETTINGS,
} from "../../src/wiki/terms.ts";
import { createWikiToolServers } from "../../src/wiki/tools.ts";
import { createScriptedQuery } from "./scripted-query.ts";

export const E2E_PORT = Number(process.env.E2E_PORT ?? 45200);
export const E2E_TOKEN = "e2e-token";
/** E2E_NO_AUTH=1 なら、トークンを要求しないモード（CC_MANABU_NO_AUTH=1 相当）で起動する。 */
const NO_AUTH = process.env.E2E_NO_AUTH === "1";

const opened = openDatabase(":memory:");
if (Result.isFailure(opened)) throw opened.error;
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
  tasks,
  wiki,
  descriptionOf: (taskId) => {
    const description = environments.descriptionOfTask(taskId);
    return Result.isSuccess(description) ? description.value : undefined;
  },
  extract: async (prompt) =>
    (await generateText({ model: termModel, prompt })).text,
});
const summaryModel = createClaudeCode({
  cwd: "/e2e",
  query,
  ...ANSWER_SUMMARY_SETTINGS,
})(ANSWER_SUMMARY_MODEL);
const summarizeAnswer = createAnswerSummarizer({
  chats,
  summarize: async (prompt) =>
    (await generateText({ model: summaryModel, prompt })).text,
});
const pageModel = createClaudeCode({
  cwd: "/e2e",
  query,
  ...PAGE_GENERATION_SETTINGS,
})(PAGE_GENERATION_MODEL);
const generateWikiPage = createWikiPageGenerator({
  tasks,
  chats,
  wiki,
  readWikiPage: createWikiPageReader(wiki, tasks),
  generate: async (prompt) =>
    (await generateText({ model: pageModel, prompt })).text,
});
const threadTitleModel = createClaudeCode({
  cwd: "/e2e",
  query,
  ...THREAD_TITLE_SETTINGS,
})(THREAD_TITLE_MODEL);
const wikiThreadTitler = createWikiThreadTitler({
  chats,
  generate: async (prompt) =>
    (await generateText({ model: threadTitleModel, prompt })).text,
});
const pageQaModel = createClaudeCode({
  cwd: "/e2e",
  query,
  ...PAGE_QA_SETTINGS,
})(PAGE_QA_MODEL);
const writePageQa = createPageQaWriter({
  chats,
  wiki,
  generate: async (prompt) =>
    (await generateText({ model: pageQaModel, prompt })).text,
});
const registry = new RunnerRegistry();
const chatService = createChatService({
  chats,
  registry,
  approvals,
  languageModel: (modelId, options) =>
    createClaudeCode({ cwd: "/e2e", query, onRateLimit, ...options })(modelId),
  taskTools: createTaskToolServers({ tasks }),
  wikiTools: createWikiToolServers({ wiki, tasks, history: wikiHistory }),
  onWikiBatchFinish: (batchId, messageId) =>
    wikiHistory.attachAnswer(batchId, messageId),
  wikiContext: createWikiContextBuilder(wiki, tasks),
  taskContext: createTaskContextBuilder(tasks, environments),
  readWikiPage: createWikiPageReader(wiki, tasks),
  directoriesOf: (taskId) => {
    const directories = environments.directoriesOfTask(taskId);
    return Result.isSuccess(directories) ? directories.value : undefined;
  },
  onRunnerFinish: (chatId, outcome) =>
    queueDispatcher?.onRunnerFinish(chatId, outcome),
  onAnswerComplete: (event) => void writeTermPages(event),
  onAnswerFinish: (event) => {
    void summarizeAnswer(event);
    void wikiThreadTitler.onAnswerFinish(event);
    void writePageQa(event);
  },
  onWikiChatCreated: (chat) => wikiThreadTitler.track(chat),
});
queueDispatcher = createQueueDispatcher({ queue, registry, chatService });
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
  token: NO_AUTH ? null : E2E_TOKEN,
  router,
  index,
  context: {
    chats,
    tasks,
    environments,
    wiki,
    queue,
    queueDispatcher,
    search: createSearchRepository(opened.value.db),
    rateLimits,
    preferences: createPreferencesRepository(opened.value.db),
    wikiHistory,
    chatService,
    approvals,
    claude,
    generateWikiPage,
    cwd: "/e2e",
    // フォルダを選ぶダイアログの代わりに、E2E_PICKED_DIR（無ければ一時ディレクトリ）を返す
    pickDirectory: async () =>
      Result.succeed(process.env.E2E_PICKED_DIR ?? realpathSync(tmpdir())),
  },
});
if (Result.isFailure(started)) throw started.error;
console.log(`e2e server: ${started.value.url}`);
