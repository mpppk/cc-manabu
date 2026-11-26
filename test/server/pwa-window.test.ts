import { describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import {
  closePwaOnExit,
  closeWindowsScript,
  LIST_WINDOWS_SCRIPT,
  PwaWindowError,
  parseWindowList,
  type RunAppleScript,
  trackPwaWindow,
} from "../../src/server/pwa-window.ts";

const ORIGIN = "http://127.0.0.1:4317/";

const line = (id: number, tabs: number, url: string) =>
  `${id}\t${tabs}\t${url}\n`;

/** 一覧の出力を順に返し、閉じる要求を記録する osascript の代わり。 */
const fakeChrome = (lists: (string | "fail")[]) => {
  const closed: string[] = [];
  let index = 0;
  const run: RunAppleScript = async (script) => {
    if (script === LIST_WINDOWS_SCRIPT) {
      const output = lists[Math.min(index, lists.length - 1)] ?? "";
      index++;
      return output === "fail"
        ? Result.fail(new PwaWindowError({ detail: "not allowed" }))
        : Result.succeed(output);
    }
    closed.push(script);
    return Result.succeed("");
  };
  return { run, closed };
};

const deps = (run: RunAppleScript) => ({
  run,
  sleep: async () => {},
  timeoutMs: 3,
  intervalMs: 1,
});

describe("PWA のウィンドウ（#182）", () => {
  test("一覧を読み、Chrome が動いていなければ undefined", () => {
    expect(
      parseWindowList(
        line(10, 1, `${ORIGIN}c/abc`) + line(11, 3, "https://example.com/"),
      ),
    ).toEqual([
      { id: "10", tabs: 1, url: `${ORIGIN}c/abc` },
      { id: "11", tabs: 3, url: "https://example.com/" },
    ]);
    expect(parseWindowList("NOT_RUNNING\n")).toBeUndefined();
    expect(closeWindowsScript(["10", "12"])).toContain("{10, 12}");
  });

  test("起動前になかった PWA のウィンドウだけを閉じる", async () => {
    const before =
      line(1, 5, "https://example.com/") + // Chrome 本体
      line(2, 1, `${ORIGIN}c/old`) + // 起動前から開いていた cc-manabu
      line(3, 1, "http://127.0.0.1:9999/"); // 別の PWA
    const { run, closed } = fakeChrome([
      before,
      before,
      `${before}${line(4, 1, `${ORIGIN}#token=x`)}${line(5, 2, `${ORIGIN}c/tab`)}`,
    ]);
    const tracker = await trackPwaWindow(ORIGIN, deps(run));
    await tracker.findLaunched();
    expect(await tracker.close()).toBe(1);
    expect(closed).toEqual([closeWindowsScript(["4"])]);
    // 2 回目は何もしない
    expect(await tracker.close()).toBe(0);
  });

  test("Chrome が動いていなかったときは、起動後に現れた PWA のウィンドウを閉じる", async () => {
    const { run, closed } = fakeChrome([
      "NOT_RUNNING",
      line(7, 1, `${ORIGIN}`),
    ]);
    const tracker = await trackPwaWindow(ORIGIN, deps(run));
    await tracker.findLaunched();
    expect(await tracker.close()).toBe(1);
    expect(closed).toEqual([closeWindowsScript(["7"])]);
  });

  test("既存のウィンドウが再利用されたとき・一覧を取れないときは閉じない", async () => {
    const existing = line(2, 1, `${ORIGIN}c/old`);
    const reused = fakeChrome([existing]);
    const tracker = await trackPwaWindow(ORIGIN, deps(reused.run));
    await tracker.findLaunched();
    expect(await tracker.close()).toBe(0);
    expect(reused.closed).toEqual([]);

    const denied = fakeChrome(["fail"]);
    const untracked = await trackPwaWindow(ORIGIN, deps(denied.run));
    await untracked.findLaunched();
    expect(await untracked.close()).toBe(0);
    expect(denied.closed).toEqual([]);
  });

  test("Ctrl+C で閉じてから終了し、閉じられなくても終了する", async () => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    const exited = new Promise<void>((resolve) => {
      closePwaOnExit(
        { close: () => Promise.reject(new Error("failed")) },
        {
          on: ((event: string, handler: () => void) => {
            handlers.set(event, handler);
          }) as never,
          exit: ((code: number) => {
            exits.push(code);
            resolve();
          }) as never,
        },
      );
    });
    handlers.get("SIGINT")?.();
    await exited;
    expect(exits).toEqual([130]);
  });
});
