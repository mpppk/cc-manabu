import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import type { PwaOptions } from "../runtime-config.ts";

export class PwaLaunchError extends ErrorFactory({
  name: "PwaLaunchError",
  message: ({ detail }) => detail,
  fields: ErrorFactory.fields<{ detail: string }>(),
}) {}

const failure = (detail: string) => Result.fail(new PwaLaunchError({ detail }));

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest();

/** Chromium の App ID は、マニフェスト ID を二重にハッシュして先頭 16 バイトを a–p で表す。 */
export const chromeAppId = (manifestId: string) =>
  Array.from(
    sha256(sha256(manifestId)).subarray(0, 16).toString("hex"),
    (hex) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(hex, 16)),
  ).join("");

const chromeExecutable = "Google Chrome.app/Contents/MacOS/Google Chrome";

const systemDefaults = {
  platform: process.platform,
  home: homedir,
  exists: (path: string) => existsSync(path),
  list: (path: string) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  spawn: (command: string[]) => {
    const child = Bun.spawn(command, {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
    return child.exited;
  },
};

const isProfileDirectory = (name: string) =>
  name !== "" && name !== "." && name !== ".." && !/[/\\\\]/.test(name);

/** ユーザーデータディレクトリの中から Chrome のプロファイル（Default、Profile N）を探す順に並べる。 */
const chromeProfiles = (entries: readonly string[]) =>
  entries
    .filter((name) => name === "Default" || /^Profile \d+$/.test(name))
    .sort(
      (a, b) =>
        (a === "Default" ? 0 : Number(a.slice("Profile ".length))) -
        (b === "Default" ? 0 : Number(b.slice("Profile ".length))),
    );

/** Chrome のバイナリに直接渡し、実行中であれば同じ Chrome プロセスに起動を引き継がせる。 */
export const openPwa = async (
  url: string,
  options: PwaOptions,
  system = systemDefaults,
): Result.ResultAsync<void, PwaLaunchError> => {
  if (system.platform !== "darwin") {
    return failure(
      "PWA の CLI 起動は macOS の Google Chrome に対応しています。",
    );
  }
  const home = system.home();
  const chrome = [
    join("/Applications", chromeExecutable),
    join(home, "Applications", chromeExecutable),
  ].find(system.exists);
  if (chrome === undefined) {
    return failure("Google Chrome が Applications に見つかりません。");
  }

  const manifestId = new URL("/", url).href;
  const expectedAppId = chromeAppId(manifestId);
  const appId = options.appId ?? expectedAppId;
  if (appId !== expectedAppId) {
    return failure(
      "MONET_CHROME_APP_ID が起動 URL と一致しません。インストール時のポートとアプリ ID を確認してください。",
    );
  }

  const userData = join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  );
  const installedIn = (profile: string) =>
    system.exists(
      join(userData, profile, "Web Applications", "Manifest Resources", appId),
    );

  const { profile: requested } = options;
  if (requested !== undefined && !isProfileDirectory(requested)) {
    return failure(
      "MONET_CHROME_PROFILE に Chrome のプロファイルのディレクトリ名を指定してください。",
    );
  }
  const profile =
    requested ??
    chromeProfiles(system.list(userData)).find((name) => installedIn(name));
  if (profile === undefined) {
    return failure(
      `Chrome のどのプロファイルにも monet が見つかりません。${manifestId} からインストールしてください。`,
    );
  }
  if (!installedIn(profile)) {
    return failure(
      `Chrome プロファイル「${profile}」に monet が見つかりません。${manifestId} からインストールしてください。`,
    );
  }

  const launched = await Result.try({
    try: () =>
      Promise.race([
        system.spawn([
          chrome,
          `--profile-directory=${profile}`,
          `--app-id=${appId}`,
          `--app-launch-url-for-shortcuts-menu-item=${url}`,
        ]),
        // 起動済みなら引き継いで終了し、Chrome 本体として起動したときは待たない。
        Bun.sleep(1000).then(() => undefined),
      ]),
    catch: (cause) =>
      new PwaLaunchError({
        detail: "Google Chrome を起動できませんでした。",
        cause,
      }),
  });
  if (Result.isFailure(launched)) return launched;

  const exitCode = launched.value;
  return exitCode === undefined || exitCode === 0
    ? Result.succeed()
    : failure(`Google Chrome の起動に失敗しました（終了コード ${exitCode}）。`);
};

/** monet をそのポートで起動したときの PWA のマニフェスト ID。 */
const manifestIdForPort = (port: number) => `http://127.0.0.1:${port}/`;

/** 自動で見つけた、インストール済みの PWA。 */
export type InstalledPwa = { port: number; profile: string; appId: string };

/**
 * 通常の起動（--pwa なし）で、Chrome にインストール済みの monet の PWA を探す（#163）。
 *
 * - port（MONET_PORT）があれば、そのポートの URL の PWA だけを照合する
 * - 無ければ、すべてのポートの URL のアプリ ID を求めて、インストール済みのアプリと照合する。
 *   1 つに決まればそのポート、複数あれば失敗（ポートの指定を案内する）
 * - profile・appId（MONET_CHROME_PROFILE・MONET_CHROME_APP_ID）があれば、それに絞る
 *
 * 対応していない環境（macOS の Google Chrome 以外）や、見つからなければ undefined。
 */
export const findInstalledPwa = (
  options: { port: number } & PwaOptions,
  system: Pick<
    typeof systemDefaults,
    "platform" | "home" | "exists" | "list"
  > = systemDefaults,
): Result.Result<InstalledPwa | undefined, PwaLaunchError> => {
  if (system.platform !== "darwin") return Result.succeed(undefined);
  const home = system.home();
  const hasChrome = [
    join("/Applications", chromeExecutable),
    join(home, "Applications", chromeExecutable),
  ].some(system.exists);
  if (!hasChrome) return Result.succeed(undefined);

  const userData = join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  );
  const { profile: requested } = options;
  if (requested !== undefined && !isProfileDirectory(requested)) {
    return failure(
      "MONET_CHROME_PROFILE に Chrome のプロファイルのディレクトリ名を指定してください。",
    );
  }
  const installed = (
    requested === undefined
      ? chromeProfiles(system.list(userData))
      : [requested]
  )
    .map((profile) => ({
      profile,
      appIds: new Set(
        system.list(
          join(userData, profile, "Web Applications", "Manifest Resources"),
        ),
      ),
    }))
    .filter(({ appIds }) => appIds.size > 0);
  if (installed.length === 0) return Result.succeed(undefined);

  const ports =
    options.port !== 0
      ? [options.port]
      : Array.from({ length: 65535 }, (_, index) => index + 1);
  const found: InstalledPwa[] = [];
  for (const port of ports) {
    const appId = chromeAppId(manifestIdForPort(port));
    if (options.appId !== undefined && appId !== options.appId) continue;
    const match = installed.find(({ appIds }) => appIds.has(appId));
    if (match !== undefined) {
      found.push({ port, profile: match.profile, appId });
    }
  }
  if (found.length > 1) {
    return failure(
      `monet の PWA が複数のポート（${found
        .map((pwa) => pwa.port)
        .join(
          "、",
        )}）でインストールされています。使うポートを MONET_PORT に指定してください（例: MONET_PORT=${found[0]?.port} monet）。`,
    );
  }
  return Result.succeed(found[0]);
};
