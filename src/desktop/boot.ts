import { createRouterClient } from "@orpc/server";
import { createAppContext } from "../app-context.ts";
import { probeClaude } from "../claude/detect.ts";
import { normalizeDirectoriesAsync } from "../environment/directories.ts";
import {
  createDirectoryPicker,
  type RunCommand,
} from "../environment/directory-picker.ts";
import { router } from "../router.ts";
import type { ApiClient } from "../web/lib/orpc.ts";
import { type ClaudeLaunch, createSpawnClaude } from "./claude-launch.ts";
import {
  createDatabasePersister,
  type DesktopDatabase,
  loadSqlJs,
  openDesktopDatabase,
} from "./database.ts";
import type { FullDesktopApi } from "./desktop-api.ts";
import { createProcessQuery, startProcessQuery } from "./process-query.ts";
import { applyWal } from "./wal.ts";

/** デスクトップアプリ版が読み書きするファイル。 */
export type DesktopPaths = {
  home: string;
  /** CLI 版と同じデータのディレクトリ（~/.local/share/cc-manabu）。 */
  dataDir: string;
  /** デスクトップアプリ版の DB。CLI 版とは別のファイルにする（同時に開くと壊れるため）。 */
  database: string;
  /** CLI 版の DB（取り込み元）。 */
  cliDatabase: string;
  /** claude のパスなどの設定。 */
  settings: string;
};

export const resolveDesktopPaths = (
  home: string,
  platform: string,
): DesktopPaths => {
  const sep = platform === "win32" ? "\\" : "/";
  const dataDir = [home, ".local", "share", "cc-manabu"].join(sep);
  return {
    home,
    dataDir,
    database: `${dataDir}${sep}desktop.sqlite`,
    cliDatabase: `${dataDir}${sep}db.sqlite`,
    settings: `${dataDir}${sep}desktop-settings.json`,
  };
};

export type DesktopSettings = {
  /** 見つからないときに利用者が入力した claude のパス。 */
  claudePath?: string;
};

export const readSettings = async (
  desktop: FullDesktopApi,
  paths: DesktopPaths,
): Promise<DesktopSettings> => {
  try {
    return JSON.parse(await desktop.fs.readFile(paths.settings, "utf8"));
  } catch {
    return {};
  }
};

export const writeSettings = async (
  desktop: FullDesktopApi,
  paths: DesktopPaths,
  settings: DesktopSettings,
): Promise<void> => {
  await desktop.fs.mkdir(paths.dataDir, { recursive: true });
  await desktop.fs.writeFile(
    paths.settings,
    JSON.stringify(settings, null, 2),
    "utf8",
  );
};

const readBytes = async (
  desktop: FullDesktopApi,
  path: string,
): Promise<Uint8Array | undefined> => {
  if (!(await desktop.fs.exists(path))) return undefined;
  return await desktop.fs.readFile(path);
};

/** 起動時の DB の状態。CLI 版の DB しか無ければ、取り込むか利用者に選んでもらう。 */
export type StorageState =
  | { kind: "existing" }
  | { kind: "importable"; cliDatabase: string }
  | { kind: "new" };

export const inspectStorage = async (
  desktop: FullDesktopApi,
  paths: DesktopPaths,
): Promise<StorageState> => {
  if (await desktop.fs.exists(paths.database)) return { kind: "existing" };
  if (await desktop.fs.exists(paths.cliDatabase)) {
    return { kind: "importable", cliDatabase: paths.cliDatabase };
  }
  return { kind: "new" };
};

/** CLI 版の DB を、WAL に残っているデータごと読む。 */
export const readCliDatabase = async (
  desktop: FullDesktopApi,
  paths: DesktopPaths,
): Promise<Uint8Array> => {
  const main = await readBytes(desktop, paths.cliDatabase);
  if (main === undefined) throw new Error("CLI 版の DB が見つかりません");
  const wal = await readBytes(desktop, `${paths.cliDatabase}-wal`);
  return wal === undefined ? main : applyWal(main, wal).bytes;
};

/** DB ファイルを壊さないよう、一時ファイルに書いてから置き換える。 */
const saveDatabase =
  (desktop: FullDesktopApi, paths: DesktopPaths) =>
  async (bytes: Uint8Array) => {
    const temporary = `${paths.database}.tmp`;
    await desktop.fs.writeFile(temporary, bytes);
    await desktop.fs.rename(temporary, paths.database);
  };

export type OpenedStorage = DesktopDatabase & {
  persister: ReturnType<typeof createDatabasePersister>;
};

/**
 * DB を開いて、変更を書き出す仕組みを動かす。
 * source が "cli" なら CLI 版の DB から始める（取り込み）。
 */
export const openStorage = async (
  desktop: FullDesktopApi,
  paths: DesktopPaths,
  source: "desktop" | "cli" | "new",
  onSaveError: (error: unknown) => void,
): Promise<OpenedStorage> => {
  await desktop.fs.mkdir(paths.dataDir, { recursive: true });
  const bytes =
    source === "desktop"
      ? await readBytes(desktop, paths.database)
      : source === "cli"
        ? await readCliDatabase(desktop, paths)
        : undefined;
  const SQL = await loadSqlJs();
  const opened = openDesktopDatabase(SQL, bytes);
  const persister = createDatabasePersister({
    sqlite: opened.sqlite,
    save: saveDatabase(desktop, paths),
    dirty: source !== "desktop" || opened.migrated.length > 0,
    onError: onSaveError,
  });
  await persister.flush();
  return { ...opened, persister };
};

/** desktop.childProcess でコマンドを実行し、出力と終了コードを集める。 */
const runWithDesktop =
  (desktop: FullDesktopApi): RunCommand =>
  ([command = "", ...args]) =>
    new Promise((resolve) => {
      const child = desktop.childProcess.spawn(command, args);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) =>
        resolve({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` }),
      );
      child.on("exit", (code) =>
        resolve({ exitCode: code ?? 1, stdout, stderr }),
      );
    });

/** router をこのページの中で動かし、Web UI と同じ API クライアントとして返す。 */
export const createDesktopApi = async (params: {
  desktop: FullDesktopApi;
  platform: string;
  paths: DesktopPaths;
  launch: ClaudeLaunch;
  storage: OpenedStorage;
}): Promise<ApiClient> => {
  const { desktop, platform, paths, launch, storage } = params;
  const spawnClaude = createSpawnClaude(desktop, launch);
  const query = createProcessQuery(spawnClaude);
  const hasZenity =
    platform === "linux" &&
    (await desktop.childProcess
      .exec("command -v zenity", { timeout: 5_000 })
      .then((result) => result.code === 0)
      .catch(() => false));
  const context = createAppContext({
    db: storage.db,
    cwd: paths.home,
    claude: { found: true, path: launch.path },
    claudeStatus: {
      version: async () => launch.version,
      // モデル一覧とアカウントは initialize の応答から取る（Agent SDK と同じ）
      probe: (path) =>
        probeClaude(path, {
          query: ({ prompt, options }) => {
            const probe = startProcessQuery(spawnClaude, prompt, options);
            return {
              supportedModels: () => probe.supportedModels(),
              accountInfo: () => probe.accountInfo(),
              return: async () => {
                await probe.return();
                return { done: true, value: undefined };
              },
            };
          },
        }),
    },
    provider: { query },
    pickDirectory: createDirectoryPicker({
      platform: platform as NodeJS.Platform,
      which: (name) => (name === "zenity" && hasZenity ? name : null),
      run: runWithDesktop(desktop),
    }),
    normalizeDirectories: (directories) =>
      normalizeDirectoriesAsync(directories, {
        home: paths.home,
        isDirectory: (path) =>
          desktop.fs
            .stat(path)
            .then((stats) => stats.isDirectory)
            .catch(() => false),
      }),
  });
  return createRouterClient(router, { context });
};
