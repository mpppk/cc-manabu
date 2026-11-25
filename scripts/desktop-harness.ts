#!/usr/bin/env bun
import * as fs from "node:fs/promises";
/**
 * デスクトップアプリ版（artifact）を、Claude デスクトップアプリの外で動かして確かめるハーネス。
 *
 *   bun run build:artifact
 *   bun scripts/desktop-harness.ts            # 実機の claude で一通り操作する（利用枠を少し使う）
 *   bun scripts/desktop-harness.ts --keep     # 終わってもブラウザとデータを残す（調査用）
 *
 * dist/artifact を artifact と同じ形（ページの断片を <html> で包む）で配信し、Playwright の
 * Chromium で開く。`window.claude.use("desktop")` は、このマシンの fs と子プロセスにつないだ
 * 偽物を返す（ホームディレクトリは一時ディレクトリ）。Claude Code は本物の `claude` を使う。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, type Page } from "@playwright/test";

const dist = path.resolve(
  process.argv.includes("--dist")
    ? (process.argv[process.argv.indexOf("--dist") + 1] ?? "")
    : "dist/artifact",
);
const keep = process.argv.includes("--keep");
const home = await mkdtemp(path.join(tmpdir(), "cc-manabu-desktop-home-"));
const screenshots = path.resolve(
  Bun.env.SCREENSHOT_DIR ?? path.join(home, "screenshots"),
);
await fs.mkdir(screenshots, { recursive: true });

/** Claude Code の入れ子のセッションとして扱われないよう、親の Claude Code の変数を外す。 */
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^CLAUDE_CODE_(CHILD_SESSION|REMOTE_SESSION_ID|SESSION_ID|CCR)/.test(
        key,
      ),
  ),
) as Record<string, string>;

const expandHome = (p: string) =>
  p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;

// ---- artifact のページを配信する ----
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const body = Bun.file(path.join(dist, file));
    if (!(await body.exists()))
      return new Response("not found", { status: 404 });
    if (file === "index.html") {
      const fragment = await body.text();
      return new Response(
        `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>${fragment}</body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return new Response(body);
  },
});

// ---- desktop API の橋渡し（Node 側） ----
type Proc = Bun.Subprocess<"pipe", "pipe", "pipe">;
const procs = new Map<number, Proc>();
let nextId = 0;
const log: string[] = [];

const handlers = (page: Page): Record<string, (payload: never) => unknown> => ({
  "os.platform": () => process.platform,
  "os.arch": () => process.arch,
  "os.homedir": () => home,
  "fs.readFile": async ({
    path: p,
    encoding,
  }: {
    path: string;
    encoding?: string;
  }) => {
    const bytes = await fs.readFile(expandHome(p));
    return encoding === "utf8"
      ? bytes.toString("utf8")
      : bytes.toString("base64");
  },
  "fs.writeFile": async ({
    path: p,
    data,
    base64,
  }: {
    path: string;
    data: string;
    base64: boolean;
  }) => {
    await fs.writeFile(
      expandHome(p),
      base64 ? Buffer.from(data, "base64") : data,
    );
  },
  "fs.stat": async ({ path: p }: { path: string }) => {
    const s = await fs.stat(expandHome(p));
    return {
      size: s.size,
      mtimeMs: s.mtimeMs,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
    };
  },
  "fs.exists": async ({ path: p }: { path: string }) =>
    fs.access(expandHome(p)).then(
      () => true,
      () => false,
    ),
  "fs.mkdir": async ({
    path: p,
    recursive,
  }: {
    path: string;
    recursive?: boolean;
  }) => {
    await fs.mkdir(expandHome(p), { recursive });
  },
  "fs.rename": async ({ from, to }: { from: string; to: string }) => {
    await fs.rename(expandHome(from), expandHome(to));
  },
  "fs.copyFile": async ({ from, to }: { from: string; to: string }) => {
    await fs.copyFile(expandHome(from), expandHome(to));
  },
  exec: async ({
    command,
    cwd,
    timeout,
  }: {
    command: string;
    cwd?: string;
    timeout?: number;
  }) => {
    log.push(`exec: ${command}`);
    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: cwd === undefined ? home : expandHome(cwd),
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
      timeout,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      stdout,
      stderr,
      code,
      signal: proc.signalCode ?? null,
      truncated: false,
    };
  },
  spawn: ({
    command,
    args,
    cwd,
  }: {
    command: string;
    args: string[];
    cwd?: string;
  }) => {
    const id = ++nextId;
    log.push(`spawn #${id}: ${command} ${args.slice(0, 6).join(" ")}…`);
    const proc = Bun.spawn([command, ...args], {
      cwd: cwd === undefined ? home : expandHome(cwd),
      env: childEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    procs.set(id, proc);
    const emit = (kind: string, data: unknown) =>
      page
        .evaluate(
          ([i, k, d]) =>
            (
              window as never as { __desktopEmit: (...a: unknown[]) => void }
            ).__desktopEmit(i, k, d),
          [id, kind, data] as const,
        )
        .catch(() => {});
    const pump = async (stream: ReadableStream<Uint8Array>, kind: string) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream)
        await emit(kind, decoder.decode(chunk, { stream: true }));
    };
    void Promise.all([
      proc.exited,
      pump(proc.stdout, "stdout"),
      pump(proc.stderr, "stderr"),
    ]).then(([code]) => {
      procs.delete(id);
      const signal = proc.signalCode === null ? null : String(proc.signalCode);
      void emit("exit", [signal === null ? code : null, signal]);
    });
    return id;
  },
  "stdin.write": async ({ id, data }: { id: number; data: string }) => {
    const proc = procs.get(id);
    if (proc === undefined) throw new Error("ESRCH: process exited");
    proc.stdin.write(data);
    await proc.stdin.flush();
  },
  "stdin.end": async ({ id }: { id: number }) => {
    await procs.get(id)?.stdin.end();
  },
  kill: ({ id, signal }: { id: number; signal?: string }) => {
    procs.get(id)?.kill((signal ?? "SIGTERM") as NodeJS.Signals);
  },
  notify: ({ body }: { body: string }) => {
    log.push(`notification: ${body}`);
  },
  badge: ({ text }: { text: string }) => {
    log.push(`badge: ${text}`);
  },
});

/** ページ側: window.claude.use("desktop") が返す偽物。 */
const pageShim = () => {
  const call = (op: string, payload: unknown = {}) =>
    (
      window as never as {
        __desktop: (op: string, payload: unknown) => Promise<unknown>;
      }
    ).__desktop(op, payload);
  const toBase64 = (bytes: Uint8Array) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromBase64 = (b64: string) =>
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const children = new Map<
    number,
    Record<string, ((...a: unknown[]) => void)[]>
  >();
  (window as never as { __desktopEmit: unknown }).__desktopEmit = (
    id: number,
    kind: string,
    data: unknown,
  ) => {
    const listeners = children.get(id)?.[kind] ?? [];
    for (const fn of listeners)
      fn(...(kind === "exit" ? (data as unknown[]) : [data]));
  };
  const granted = {
    "full-access": "granted",
    notifications: "granted",
    shortcuts: "unavailable",
    overlay: "unavailable",
    "menu-bar": "unavailable",
  };
  const desktop = {
    install: {
      state: async () => "installed",
      request: async () => "installed",
    },
    permissions: {
      state: async () => granted,
      request: async () => granted,
      manage: async () => {},
    },
    app: {
      dock: {
        setIcon: async () => ({ written: true }),
        setBadge: async (text: string) => {
          await call("badge", { text });
          return true;
        },
      },
    },
    notification: { show: (o: { body: string }) => call("notify", o) },
    os: {
      platform: () => call("os.platform"),
      arch: () => call("os.arch"),
      homedir: () => call("os.homedir"),
    },
    fs: {
      readFile: async (p: string, encoding?: string) => {
        const r = (await call("fs.readFile", { path: p, encoding })) as string;
        return encoding === "utf8"
          ? r
          : encoding === "base64"
            ? r
            : fromBase64(r);
      },
      writeFile: (p: string, data: string | Uint8Array) =>
        call(
          "fs.writeFile",
          typeof data === "string"
            ? { path: p, data, base64: false }
            : { path: p, data: toBase64(data), base64: true },
        ),
      stat: (p: string) => call("fs.stat", { path: p }),
      exists: (p: string) => call("fs.exists", { path: p }),
      mkdir: (p: string, o?: { recursive?: boolean }) =>
        call("fs.mkdir", { path: p, recursive: o?.recursive }),
      rename: (from: string, to: string) => call("fs.rename", { from, to }),
      copyFile: (from: string, to: string) => call("fs.copyFile", { from, to }),
    },
    childProcess: {
      exec: (command: string, o: { cwd?: string; timeout?: number } = {}) =>
        call("exec", { command, ...o }),
      spawn: (
        command: string,
        args: string[] = [],
        o: { cwd?: string } = {},
      ) => {
        const listeners: Record<string, ((...a: unknown[]) => void)[]> = {
          stdout: [],
          stderr: [],
          exit: [],
          error: [],
        };
        const idPromise = call("spawn", {
          command,
          args,
          cwd: o.cwd,
        }) as Promise<number>;
        idPromise.then(
          (id) => children.set(id, listeners),
          (e) => {
            for (const fn of listeners.error ?? []) fn(e);
          },
        );
        const withId = async (op: string, extra: object = {}) =>
          call(op, { id: await idPromise, ...extra });
        return {
          pid: idPromise,
          stdout: {
            on: (_: string, fn: (c: string) => void) =>
              listeners.stdout?.push(fn as never),
          },
          stderr: {
            on: (_: string, fn: (c: string) => void) =>
              listeners.stderr?.push(fn as never),
          },
          stdin: {
            write: (data: string) => withId("stdin.write", { data }),
            end: () => withId("stdin.end"),
          },
          on: (event: string, fn: (...a: unknown[]) => void) =>
            listeners[event]?.push(fn),
          kill: (signal?: string) => withId("kill", { signal }),
        };
      },
    },
  };
  (window as never as { claude: unknown }).claude = {
    use: async (name: string) => (name === "desktop" ? desktop : null),
  };
};

const browser = await chromium.launch({ headless: !keep });
const context = await browser.newContext({
  viewport: { width: 1280, height: 860 },
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
const ops = handlers(page);
await page.exposeFunction("__desktop", async (op: string, payload: never) => {
  const handler = ops[op];
  if (handler === undefined) throw new Error(`unknown op: ${op}`);
  return await handler(payload);
});
await page.addInitScript(pageShim);

const shot = async (name: string) => {
  const file = path.join(screenshots, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  screenshot: ${file}`);
};
const step = (name: string) => console.log(`- ${name}`);

try {
  // プロジェクトの設定で Bash を毎回確認にし、承認カードを必ず通す
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { ask: ["Bash"] } }),
  );

  step("起動して Claude Code の状態が出るのを待つ");
  await page.goto(server.url.href);
  await expect(page.getByText(/^Claude Code \d+\.\d+\.\d+/)).toBeVisible({
    timeout: 60_000,
  });
  await shot("01-ready");

  step("新しいスレッドで質問し、ストリーミングの回答を受け取る");
  const row = page
    .getByRole("navigation", { name: "会話一覧" })
    .locator("li[data-unassigned] > div.group");
  await row.hover();
  await row.getByRole("button", { name: /に新しいスレッド$/ }).click();
  const box = page.getByRole("textbox", { name: "メッセージ", exact: true });
  await box.fill("「デスクトップ版 OK」とだけ返してください。");
  await box.press("Enter");
  await expect(page.getByText("デスクトップ版 OK").last()).toBeVisible({
    timeout: 90_000,
  });
  await expect(
    page.getByRole("button", { name: "送信", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await shot("02-answer");

  step("Bash の承認カードで許可し、結果を受け取る");
  await box.fill(
    "Bash ツールで `echo desktop-bash-ok` を一度だけ実行し、出力だけを返してください。",
  );
  await box.press("Enter");
  const card = page.getByRole("region", { name: "ツール実行の承認" });
  await expect(card).toBeVisible({ timeout: 90_000 });
  await shot("03-approval");
  await card.getByRole("button", { name: "許可" }).click();
  await expect(page.getByText("desktop-bash-ok").last()).toBeVisible({
    timeout: 90_000,
  });
  await expect(
    page.getByRole("button", { name: "送信", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await shot("04-tool");

  step("データがファイルに保存され、開き直しても会話が残る");
  const dbFile = path.join(
    home,
    ".local",
    "share",
    "cc-manabu",
    "desktop.sqlite",
  );
  await expect
    .poll(
      async () => (await fs.stat(dbFile).catch(() => undefined))?.size ?? 0,
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByText(/^Claude Code \d+\.\d+\.\d+/)).toBeVisible({
    timeout: 60_000,
  });
  const tree = page.getByRole("navigation", { name: "会話一覧" });
  const saved = tree.getByRole("button", { name: /デスクトップ版 OK/ });
  await expect(saved).toBeVisible({ timeout: 15_000 });
  await saved.click();
  await expect(page.getByText("desktop-bash-ok").last()).toBeVisible({
    timeout: 15_000,
  });
  await shot("05-reloaded");
  console.log(`  db: ${dbFile} (${(await fs.stat(dbFile)).size} bytes)`);

  console.log("\nOK");
} catch (error) {
  await shot("failure").catch(() => {});
  console.error("\nFAILED:", error);
  process.exitCode = 1;
} finally {
  console.log("\nlog:\n", log.slice(-25).join("\n "));
  if (errors.length)
    console.log("\npage errors:\n", errors.slice(0, 15).join("\n "));
  if (!keep) {
    for (const [, proc] of procs) proc.kill();
    await browser.close();
    server.stop(true);
    if (process.exitCode !== 1)
      await rm(home, { recursive: true, force: true });
  }
}
