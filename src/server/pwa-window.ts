/**
 * CLI の起動で開いた PWA のウィンドウを覚えておき、Ctrl+C で終了するときに閉じる（#182）。
 *
 * Chrome の AppleScript でウィンドウの一覧（id とアクティブなタブの URL）を取り、
 * 起動の前になかった cc-manabu のウィンドウだけを「今回開いたウィンドウ」とみなす。
 * 起動前から開いていたウィンドウが再利用されたときや、特定できないときは何も閉じない。
 * 初回は macOS がターミナルから Chrome の操作を許可するか尋ねる。許可されなければ何もしない。
 */
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

export class PwaWindowError extends ErrorFactory({
  name: "PwaWindowError",
  message: ({ detail }) => detail,
  fields: ErrorFactory.fields<{ detail: string }>(),
}) {}

/** osascript で AppleScript を動かし、標準出力を返す。 */
export type RunAppleScript = (
  script: string,
) => Result.ResultAsync<string, PwaWindowError>;

export type ChromeWindow = { id: string; tabs: number; url: string };

const NOT_RUNNING = "NOT_RUNNING";

/**
 * Chrome のウィンドウの一覧を「id<TAB>タブ数<TAB>アクティブなタブの URL」の行で返す。
 * Chrome が動いていなければ起動せずに NOT_RUNNING を返す。
 */
export const LIST_WINDOWS_SCRIPT = `if application "Google Chrome" is running then
  tell application "Google Chrome"
    set out to ""
    repeat with w in windows
      try
        set out to out & (id of w as text) & tab & ((count of tabs of w) as text) & tab & (URL of active tab of w) & linefeed
      end try
    end repeat
    return out
  end tell
else
  return "${NOT_RUNNING}"
end if`;

/** 指定した id のウィンドウを閉じる。すでに無いウィンドウは飛ばす。Chrome が動いていなければ何もしない。 */
export const closeWindowsScript = (
  ids: readonly string[],
) => `if application "Google Chrome" is running then
  tell application "Google Chrome"
    repeat with targetId in {${ids.join(", ")}}
      try
        close (first window whose id is (targetId as integer))
      end try
    end repeat
  end tell
end if`;

/** 一覧の出力を読む。Chrome が動いていなければ undefined。 */
export const parseWindowList = (output: string): ChromeWindow[] | undefined => {
  if (output.trim() === NOT_RUNNING) return undefined;
  return output
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .flatMap(([id = "", tabs = "", ...url]) =>
      /^\d+$/.test(id.trim())
        ? [{ id: id.trim(), tabs: Number(tabs), url: url.join("\t").trim() }]
        : [],
    );
};

/** cc-manabu の PWA のウィンドウ（タブが 1 つで、そのオリジンを開いているもの）。 */
export const pwaWindowsOf = (
  windows: readonly ChromeWindow[],
  origin: string,
): ChromeWindow[] =>
  windows.filter((w) => w.tabs === 1 && w.url.startsWith(origin));

const defaultRunAppleScript: RunAppleScript = async (script) => {
  try {
    const child = Bun.spawn(["osascript", "-e", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    // 許可のダイアログに答えないままでも、終了を止めないようにする
    const timer = setTimeout(() => child.kill(), 5000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return code === 0
      ? Result.succeed(stdout)
      : Result.fail(
          new PwaWindowError({
            detail: `Chrome のウィンドウを操作できませんでした（${stderr.trim() || `終了コード ${code}`}）。`,
          }),
        );
  } catch (cause) {
    return Result.fail(
      new PwaWindowError({
        detail: "osascript を実行できませんでした。",
        cause,
      }),
    );
  }
};

export type PwaWindowTracker = {
  /** 起動したあとに呼ぶ。起動前になかった PWA のウィンドウが現れるまで待って覚える。 */
  findLaunched: () => Promise<void>;
  /** 覚えたウィンドウを閉じる。閉じたウィンドウの数を返す（失敗しても 0 で返る）。 */
  close: () => Promise<number>;
};

/**
 * 起動の前に呼び、今あるウィンドウを覚える。一覧を取れなければ（許可されていないなど）、
 * 今回開いたウィンドウを特定できないので何もしないトラッカーを返す。
 */
export const trackPwaWindow = async (
  origin: string,
  deps: {
    run?: RunAppleScript;
    sleep?: (ms: number) => Promise<void>;
    /** 起動後に新しいウィンドウを待つ時間。 */
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<PwaWindowTracker> => {
  const run = deps.run ?? defaultRunAppleScript;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const intervalMs = deps.intervalMs ?? 500;

  const list = async (): Promise<ChromeWindow[] | "unknown"> => {
    const output = await run(LIST_WINDOWS_SCRIPT);
    if (Result.isFailure(output)) return "unknown";
    return parseWindowList(output.value) ?? [];
  };

  const before = await list();
  if (before === "unknown") {
    return { findLaunched: async () => {}, close: async () => 0 };
  }
  const existing = new Set(pwaWindowsOf(before, origin).map((w) => w.id));
  let launched: string[] = [];

  return {
    findLaunched: async () => {
      for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
        const now = await list();
        if (now === "unknown") return;
        const added = pwaWindowsOf(now, origin)
          .map((w) => w.id)
          .filter((id) => !existing.has(id));
        if (added.length > 0) {
          launched = added;
          return;
        }
        await sleep(intervalMs);
      }
    },
    close: async () => {
      if (launched.length === 0) return 0;
      const ids = launched;
      launched = [];
      const closed = await run(closeWindowsScript(ids));
      return Result.isSuccess(closed) ? ids.length : 0;
    },
  };
};

/**
 * Ctrl+C（SIGINT）・SIGTERM で終了するとき、今回開いた PWA のウィンドウを閉じてから終了する。
 * 閉じられなくても終了する。2 回目のシグナルでは待たずに終了する。
 */
export const closePwaOnExit = (
  tracker: Pick<PwaWindowTracker, "close">,
  target: Pick<NodeJS.Process, "on" | "exit"> = process,
) => {
  let closing = false;
  const onSignal = (code: number) => () => {
    if (closing) target.exit(code);
    closing = true;
    void tracker
      .close()
      .catch(() => 0)
      .finally(() => target.exit(code));
  };
  target.on("SIGINT", onSignal(130));
  target.on("SIGTERM", onSignal(143));
};
