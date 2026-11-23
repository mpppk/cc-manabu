import { existsSync } from "node:fs";
import { Result } from "@praha/byethrow";
import { createApprovalBroker } from "./chat/approval-broker.ts";
import { createChatService } from "./chat/chat-service.ts";
import { RunnerRegistry } from "./chat/runner-registry.ts";
import { resolveClaudePath } from "./claude/detect.ts";
import { createClaudeStatus } from "./claude/status.ts";
import { createChatRepository } from "./db/chat-repository.ts";
import { openDatabase } from "./db/index.ts";
import { resolveDbPath } from "./db/path.ts";
import { createProjectRepository } from "./db/project-repository.ts";
import { createWikiRepository } from "./db/wiki-repository.ts";
import { CliExit } from "./errors/index.ts";
import { createClaudeCode } from "./provider/index.ts";
import { router } from "./router.ts";
import type { RuntimeConfig } from "./runtime-config.ts";
import { generateToken } from "./server/access-control.ts";
import { openBrowser, startServer } from "./server/server.ts";
import index from "./web/index.html";
import { createWikiContextBuilder } from "./wiki/context.ts";

/** 引数なしで起動したときの処理: DB を開き、サーバを立ち上げてブラウザを開く。 */
export const serve = async (config: RuntimeConfig): Promise<void> => {
  const result = Result.pipe(
    openDatabase(resolveDbPath()),
    Result.andThen(({ db }) => {
      const chats = createChatRepository(db);
      const projects = createProjectRepository(db);
      const wiki = createWikiRepository(db);
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
        pathToClaudeCodeExecutable: Result.isSuccess(claudePath)
          ? claudePath.value
          : undefined,
      };
      const approvals = createApprovalBroker({
        onPendingChange: (chatId, count) =>
          chats.setStatus(chatId, count > 0 ? "awaiting_approval" : "running"),
      });
      const chatService = createChatService({
        chats,
        registry: new RunnerRegistry(),
        approvals,
        languageModel: (modelId, { canUseTool }) =>
          createClaudeCode({ ...providerSettings, canUseTool })(modelId),
        wikiContext: createWikiContextBuilder(wiki),
      });
      return startServer({
        port: config.port,
        token: generateToken(),
        router,
        index,
        development: process.env.NODE_ENV !== "production",
        context: {
          chats,
          projects,
          wiki,
          chatService,
          approvals,
          claude,
          cwd: process.cwd(),
        },
      });
    }),
  );
  if (Result.isFailure(result)) {
    console.error(result.error.message);
    throw new CliExit({ code: 1 });
  }
  const server = result.value;
  console.log(`cc-manabu を起動しました: ${server.url}`);
  console.log("終了するには Ctrl+C を押してください。");
  if (config.openBrowser) {
    openBrowser(server.url);
  }
};
