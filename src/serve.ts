import { existsSync } from "node:fs";
import { Result } from "@praha/byethrow";
import { createAppContext } from "./app-context.ts";
import { resolveClaudePath } from "./claude/detect.ts";
import { openDatabase } from "./db/index.ts";
import { resolveDbPath } from "./db/path.ts";
import { normalizeDirectories } from "./environment/directories.ts";
import { createDirectoryPicker } from "./environment/directory-picker.ts";
import { CliExit } from "./errors/index.ts";
import { router } from "./router.ts";
import type { RuntimeConfig } from "./runtime-config.ts";
import { generateToken } from "./server/access-control.ts";
import { openPwa } from "./server/open-pwa.ts";
import { openBrowser, PortInUseError, startServer } from "./server/server.ts";
import index from "./web/index.html";

/** DB を開いてサーバを立ち上げ、設定に応じてブラウザを開く。 */
export const serve = async (config: RuntimeConfig): Promise<void> => {
  if (config.pwa !== undefined && config.port === 0) {
    console.error(
      "--pwa には CC_MANABU_PORT が必要です。PWA をインストールしたときのポート（1〜65535）を指定してください。",
    );
    throw new CliExit({ code: 1 });
  }
  const result = Result.pipe(
    openDatabase(resolveDbPath()),
    Result.andThen(({ db }) => {
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
      const context = createAppContext({
        db,
        cwd: process.cwd(),
        claude: Result.isSuccess(claudePath)
          ? { found: true, path: claudePath.value }
          : { found: false, message: claudePath.error.message },
        pickDirectory: createDirectoryPicker(),
        normalizeDirectories: (paths) => normalizeDirectories(paths),
      });
      return startServer({
        port: config.port,
        token: config.requireToken ? generateToken() : null,
        router,
        index,
        development: process.env.NODE_ENV !== "production",
        context,
      });
    }),
  );
  if (Result.isFailure(result)) {
    console.error(
      result.error instanceof PortInUseError && config.pwa !== undefined
        ? `ポート ${config.port} は使用中です。インストール時と同じポートを空けてから再実行してください。`
        : result.error.message,
    );
    throw new CliExit({ code: 1 });
  }
  const server = result.value;
  if (!config.requireToken) {
    console.warn(
      "警告: CC_MANABU_NO_AUTH=1 のため、アクセストークンなしで API を呼べます（デバッグ用）。このマシンの他のプロセスやユーザーからも、Claude にファイル編集やコマンド実行をさせられます。",
    );
  }
  console.log(`cc-manabu を起動しました: ${server.url}`);
  console.log("終了するには Ctrl+C を押してください。");
  if (!config.openBrowser) return;
  if (config.pwa !== undefined) {
    const launch = await openPwa(server.url, config.pwa);
    if (Result.isSuccess(launch)) return;
    console.warn(
      `PWA を開けませんでした。 ${launch.error.message} 通常のブラウザで開きます。`,
    );
  }
  openBrowser(server.url);
};
