import { Result } from "@praha/byethrow";
import { createChatRepository } from "./db/chat-repository.ts";
import { openDatabase } from "./db/index.ts";
import { resolveDbPath } from "./db/path.ts";
import { CliExit } from "./errors/index.ts";
import { router } from "./router.ts";
import type { RuntimeConfig } from "./runtime-config.ts";
import { generateToken } from "./server/access-control.ts";
import { openBrowser, startServer } from "./server/server.ts";

/** 引数なしで起動したときの処理: DB を開き、サーバを立ち上げてブラウザを開く。 */
export const serve = async (config: RuntimeConfig): Promise<void> => {
  const result = Result.pipe(
    openDatabase(resolveDbPath()),
    Result.andThen(({ db }) =>
      startServer({
        port: config.port,
        token: generateToken(),
        router,
        context: { chats: createChatRepository(db) },
      }),
    ),
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
