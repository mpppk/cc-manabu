import { chmod, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

export const REPOSITORY = "mpppk/cc-manabu";

export class RunningFromSourceError extends ErrorFactory({
  name: "RunningFromSourceError",
  message:
    "update はリリースされたバイナリでのみ使えます（bun で実行中です）。git pull で更新してください。",
}) {}

export class UnsupportedPlatformError extends ErrorFactory({
  name: "UnsupportedPlatformError",
  message: (fields) =>
    `このプラットフォーム向けのバイナリはありません: ${fields.platform}-${fields.arch}`,
  fields: ErrorFactory.fields<{ platform: string; arch: string }>(),
}) {}

export class UpdateFetchError extends ErrorFactory({
  name: "UpdateFetchError",
  message: (fields) =>
    `ダウンロードに失敗しました: ${fields.url}（${fields.reason}）`,
  fields: ErrorFactory.fields<{ url: string; reason: string }>(),
}) {}

export class ChecksumMismatchError extends ErrorFactory({
  name: "ChecksumMismatchError",
  message: (fields) =>
    `チェックサムが一致しません（${fields.asset}）。ダウンロードしたファイルが壊れているか、改ざんされている可能性があります。`,
  fields: ErrorFactory.fields<{ asset: string }>(),
}) {}

export class UpdateInstallError extends ErrorFactory({
  name: "UpdateInstallError",
  message: "新しいバイナリへの置き換えに失敗しました",
}) {}

export type UpdateError =
  | RunningFromSourceError
  | UnsupportedPlatformError
  | UpdateFetchError
  | ChecksumMismatchError
  | UpdateInstallError;

/** "v1.2.3" / "1.2.3-beta.1" を比較用に分解する。 */
const parseVersion = (value: string): [number[], string] => {
  const [core = "", pre = ""] = value.replace(/^v/, "").split("-", 2);
  return [core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre];
};

/** a が b より新しければ正。プレリリースは同じ番号の正式版より古い。 */
export const compareVersions = (a: string, b: string): number => {
  const [coreA, preA] = parseVersion(a);
  const [coreB, preB] = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const diff = (coreA[i] ?? 0) - (coreB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (preA === preB) return 0;
  if (preA === "") return 1;
  if (preB === "") return -1;
  return preA < preB ? -1 : 1;
};

/** cd.yml が作る成果物の名前。 */
export const assetNameFor = (
  platform: string,
  arch: string,
): Result.Result<string, UnsupportedPlatformError> => {
  const os =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "darwin"
        : platform === "linux"
          ? "linux"
          : undefined;
  const supported = new Set([
    "linux-x64",
    "linux-arm64",
    "darwin-arm64",
    "windows-x64",
  ]);
  const key = `${os}-${arch}`;
  if (os === undefined || !supported.has(key)) {
    return Result.fail(new UnsupportedPlatformError({ platform, arch }));
  }
  return Result.succeed(
    `cc-manabu-${key}.${os === "windows" ? "zip" : "tar.gz"}`,
  );
};

/** checksums.txt（sha256sum の出力）から、指定したファイルのハッシュを取り出す。 */
export const findChecksum = (
  checksums: string,
  asset: string,
): string | undefined =>
  checksums
    .split("\n")
    .map((line) => line.trim().split(/\s+\*?/))
    .find(([, name]) => name === asset)?.[0];

export const sha256 = (data: ArrayBuffer): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** ソースから bun で実行しているか（update できない）。 */
export const isRunningFromSource = (execPath: string): boolean =>
  /(^|[/\\])bun(\.exe)?$/.test(execPath);

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type Fetch = (url: string) => Promise<Response>;

const fetchOk = (
  fetchFn: Fetch,
  url: string,
): Result.ResultAsync<Response, UpdateFetchError> =>
  Result.pipe(
    Result.try({
      try: () => fetchFn(url),
      catch: (cause) =>
        new UpdateFetchError({ url, reason: reasonOf(cause), cause }),
    }),
    Result.andThen((response) =>
      response.ok
        ? Result.succeed(response)
        : Result.fail(
            new UpdateFetchError({
              url,
              reason: `HTTP ${response.status}`,
              cause: new Error(`HTTP ${response.status}`),
            }),
          ),
    ),
  );

export type LatestRelease = {
  version: string;
  assetUrl: string;
  checksumsUrl: string;
  assetName: string;
};

/**
 * 最新リリースと、このプラットフォーム向けの成果物の URL を調べる。
 * GitHub API（未認証だと 60 回/時の制限がある）は使わず、
 * /releases/latest のリダイレクト先（/releases/tag/<tag>）からタグを読む。
 */
export const findLatestRelease = (deps: {
  fetch: Fetch;
  platform: string;
  arch: string;
}): Result.ResultAsync<
  LatestRelease,
  UpdateFetchError | UnsupportedPlatformError
> =>
  Result.pipe(
    assetNameFor(deps.platform, deps.arch),
    Result.andThen((assetName) => {
      const latestUrl = `https://github.com/${REPOSITORY}/releases/latest`;
      return Result.pipe(
        fetchOk(deps.fetch, latestUrl),
        Result.andThen((response) => {
          const tag = /\/releases\/tag\/([^/?#]+)/.exec(response.url)?.[1];
          if (tag === undefined) {
            return Result.fail(
              new UpdateFetchError({
                url: latestUrl,
                reason: "最新リリースのタグを特定できませんでした",
                cause: new Error("最新リリースのタグを特定できませんでした"),
              }),
            );
          }
          const base = `https://github.com/${REPOSITORY}/releases/download/${tag}`;
          return Result.succeed({
            version: decodeURIComponent(tag).replace(/^v/, ""),
            assetUrl: `${base}/${assetName}`,
            checksumsUrl: `${base}/checksums.txt`,
            assetName,
          });
        }),
      );
    }),
  );

/** 成果物をダウンロードし、チェックサムを確かめる。 */
export const downloadVerified = (
  fetchFn: Fetch,
  release: LatestRelease,
): Result.ResultAsync<ArrayBuffer, UpdateFetchError | ChecksumMismatchError> =>
  Result.pipe(
    fetchOk(fetchFn, release.checksumsUrl),
    Result.andThen((response) =>
      Result.try({
        try: () => response.text(),
        catch: (cause) =>
          new UpdateFetchError({
            url: release.checksumsUrl,
            reason: reasonOf(cause),
            cause,
          }),
      }),
    ),
    Result.andThen((checksums) =>
      Result.pipe(
        fetchOk(fetchFn, release.assetUrl),
        Result.andThen((response) =>
          Result.try({
            try: () => response.arrayBuffer(),
            catch: (cause) =>
              new UpdateFetchError({
                url: release.assetUrl,
                reason: reasonOf(cause),
                cause,
              }),
          }),
        ),
        Result.andThen((data) => {
          const expected = findChecksum(checksums, release.assetName);
          return expected !== undefined && expected === sha256(data)
            ? Result.succeed(data)
            : Result.fail(
                new ChecksumMismatchError({ asset: release.assetName }),
              );
        }),
      ),
    ),
  );

/** アーカイブを展開し、実行中のバイナリを置き換える。 */
const install = (
  data: ArrayBuffer,
  release: LatestRelease,
  target: { execPath: string; platform: string },
): Result.ResultAsync<void, UpdateInstallError> =>
  Result.try({
    try: async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cc-manabu-update-"));
      try {
        const archive = path.join(dir, release.assetName);
        await Bun.write(archive, data);
        const extract = release.assetName.endsWith(".zip")
          ? ["tar", "-xf", archive, "-C", dir]
          : ["tar", "-xzf", archive, "-C", dir];
        const proc = Bun.spawn(extract, { stdout: "ignore", stderr: "pipe" });
        if ((await proc.exited) !== 0) {
          throw new Error(await new Response(proc.stderr).text());
        }
        const { execPath, platform } = target;
        const binary = path.join(
          dir,
          platform === "win32" ? "cc-manabu.exe" : "cc-manabu",
        );
        await chmod(binary, 0o755);
        // Windows では実行中のファイルを上書きできないので、先に退避する
        if (platform === "win32") {
          await rename(execPath, `${execPath}.old`);
        }
        await rename(binary, execPath).catch(async () => {
          // 別のファイルシステムをまたぐ場合はコピーする
          await Bun.write(execPath, Bun.file(binary));
          await chmod(execPath, 0o755);
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    catch: (cause) => new UpdateInstallError({ cause }),
  });

export type UpdateOutcome =
  | { kind: "up-to-date"; version: string }
  | { kind: "updated"; from: string; to: string };

/** cc-manabu update の本体。 */
export const update = (deps: {
  currentVersion: string;
  execPath: string;
  platform: string;
  arch: string;
  fetch: Fetch;
  log: (message: string) => void;
}): Result.ResultAsync<UpdateOutcome, UpdateError> => {
  if (isRunningFromSource(deps.execPath)) {
    return Promise.resolve(Result.fail(new RunningFromSourceError()));
  }
  return Result.pipe(
    findLatestRelease(deps),
    Result.andThen((release) => {
      if (compareVersions(release.version, deps.currentVersion) <= 0) {
        return Result.succeed<UpdateOutcome>({
          kind: "up-to-date",
          version: deps.currentVersion,
        });
      }
      deps.log(`v${deps.currentVersion} → v${release.version} に更新します…`);
      return Result.pipe(
        downloadVerified(deps.fetch, release),
        Result.andThen((data) => install(data, release, deps)),
        Result.map(
          (): UpdateOutcome => ({
            kind: "updated",
            from: deps.currentVersion,
            to: release.version,
          }),
        ),
      );
    }),
  );
};
