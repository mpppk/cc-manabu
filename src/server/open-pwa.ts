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
const chromeAppId = (manifestId: string) =>
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
      "CC_MANABU_CHROME_APP_ID が起動 URL と一致しません。インストール時のポートとアプリ ID を確認してください。",
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
      "CC_MANABU_CHROME_PROFILE に Chrome のプロファイルのディレクトリ名を指定してください。",
    );
  }
  const profile =
    requested ??
    chromeProfiles(system.list(userData)).find((name) => installedIn(name));
  if (profile === undefined) {
    return failure(
      `Chrome のどのプロファイルにも cc-manabu が見つかりません。${manifestId} からインストールしてください。`,
    );
  }
  if (!installedIn(profile)) {
    return failure(
      `Chrome プロファイル「${profile}」に cc-manabu が見つかりません。${manifestId} からインストールしてください。`,
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
