/**
 * artifact の `desktop` capability のうち、cc-manabu が使う部分の型。
 * 正式な定義は artifact の実行環境が配る `desktop.d.ts`（runtime contract 0.2.x）。
 *
 * - インストールしたアプリのウィンドウでだけ `fs` などが使える。それ以外では `install` だけ。
 * - `fs` / `childProcess` / `os.homedir()` などは `"full-access"` の許可が要る。
 */

export type DesktopPermission =
  | "notifications"
  | "shortcuts"
  | "overlay"
  | "menu-bar"
  | "full-access";

export type DesktopPermissionState =
  | "granted"
  | "prompt"
  | "denied"
  | "unavailable";

export type DesktopStats = {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

/** Node の ChildProcess に似た形。stdout・stderr は文字列で届く。 */
export type DesktopChildProcess = {
  pid: Promise<number | null>;
  stdout: { on(event: "data", listener: (chunk: string) => void): void };
  stderr: { on(event: "data", listener: (chunk: string) => void): void };
  stdin: { write(data: string): Promise<unknown>; end(): Promise<unknown> };
  on(
    event: "exit" | "close",
    listener: (code: number | null, signal: string | null) => void,
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): Promise<unknown>;
};

export type DesktopApi = {
  install: {
    state(): Promise<"available" | "installed" | "unavailable">;
    request(): Promise<"installed" | "cancelled" | "unavailable" | "failed">;
  };
  permissions: {
    state(): Promise<Record<DesktopPermission, DesktopPermissionState>>;
    request(
      names?: DesktopPermission[],
    ): Promise<Record<DesktopPermission, DesktopPermissionState>>;
    manage(): Promise<void>;
  };
  app: {
    dock: {
      setIcon(pngDataUrl: string): Promise<{ written: boolean }>;
      setBadge(text: string): Promise<boolean>;
    };
  };
  fs?: {
    readFile(path: string, encoding: "utf8" | "base64"): Promise<string>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(
      path: string,
      data: string | Uint8Array,
      encoding?: "utf8" | "base64",
    ): Promise<void>;
    stat(path: string): Promise<DesktopStats>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    copyFile(from: string, to: string): Promise<void>;
  };
  childProcess?: {
    exec(
      command: string,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        timeout?: number;
        input?: string;
      },
    ): Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
      signal: string | null;
      truncated: boolean;
    }>;
    spawn(
      command: string,
      args?: string[],
      options?: { cwd?: string; env?: Record<string, string>; shell?: boolean },
    ): DesktopChildProcess;
  };
  os: {
    platform(): Promise<string>;
    arch(): Promise<string>;
    homedir(): Promise<string>;
  };
  notification?: { show(options: { body: string }): Promise<void> };
};

/** フルアクセスで使えるものがそろった `desktop`。 */
export type FullDesktopApi = DesktopApi &
  Required<Pick<DesktopApi, "fs" | "childProcess">>;

type ClaudeRuntime = {
  use(name: "desktop"): Promise<DesktopApi | null>;
};

/** artifact の実行環境から `desktop` を取り出す。artifact の外や使えない画面では null。 */
export const loadDesktopApi = async (): Promise<DesktopApi | null> => {
  const runtime = (globalThis as { claude?: ClaudeRuntime }).claude;
  if (runtime === undefined || typeof runtime.use !== "function") return null;
  try {
    return await runtime.use("desktop");
  } catch {
    return null;
  }
};

export const hasFullAccessApi = (
  desktop: DesktopApi | null,
): desktop is FullDesktopApi =>
  desktop?.fs !== undefined && desktop.childProcess !== undefined;
