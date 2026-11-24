import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, chromium, type Browser, type BrowserContext } from "@playwright/test";
import { Result } from "@praha/byethrow";
import { generateToken } from "../src/server/access-control.ts";
import { openPwa } from "../src/server/open-pwa.ts";
import { startServer } from "../src/server/server.ts";
import { router } from "../src/router.ts";
import index from "../src/web/index.html";
import { createTestContext } from "../test/helpers/context.ts";
import { createScriptedQuery } from "../test/e2e/scripted-query.ts";

const directory = mkdtempSync(join(tmpdir(), "cc-manabu-pwa-"));
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const start = (port: number) => {
  const token = generateToken();
  const test = createTestContext({ query: createScriptedQuery() });
  const result = startServer({ port, token, router, context: test.context, index });
  if (Result.isFailure(result)) throw result.error;
  return { ...result.value, token };
};
let server = start(0);
const origin = new URL("/", server.url).href;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest();
const appId = Array.from(hash(hash(origin)).subarray(0, 16).toString("hex"), (hex) =>
  String.fromCharCode(97 + Number.parseInt(hex, 16))).join("");
const profile = "Default";
const resourcePath = join(profile, "Web Applications", "Manifest Resources", appId);
let chromeProcess: ReturnType<typeof spawnChrome> | undefined;
let browser: Browser | undefined;
let warm: BrowserContext | undefined;
function spawnChrome(command: string[]) {
  return Bun.spawn(command, { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true });
}
const launch = async (cold = false) => {
  const result = await openPwa(server.url, { profile, appId }, {
    platform: process.platform,
    home: homedir,
    exists: (path) => path.endsWith(resourcePath)
      ? existsSync(join(directory, resourcePath))
      : existsSync(path),
    spawn: (command) => {
      // Only automation uses a temporary Chrome profile and a DevTools connection.
      const child = spawnChrome([
        ...command, `--user-data-dir=${directory}`,
        ...(cold ? ["--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check"] : []),
      ]);
      if (cold) chromeProcess = child;
      return child.exited;
    },
  });
  if (Result.isFailure(result)) throw result.error;
};
const poll = async <T>(get: () => Promise<T | undefined>): Promise<T> => {
  for (let i = 0; i < 100; i++) {
    const value = await get().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(250);
  }
  throw new Error("Timed out waiting for Chrome");
};
const exercise = async (label: string) => {
  const page = await poll(async () => {
    for (const candidate of warm?.pages() ?? browser?.contexts().flatMap((c) => c.pages()) ?? []) {
      if (!candidate.url().startsWith(origin)) continue;
      const page = await candidate.evaluate(() => ({
        standalone: matchMedia("(display-mode: standalone)").matches,
        token: sessionStorage.getItem("cc-manabu:token"),
        hash: location.hash,
      }));
      if (page.standalone && page.token === server.token && !page.hash) return candidate;
    }
    return undefined;
  });
  await expect(page.getByText("Claude Code 2.1.330")).toBeVisible({ timeout: 10000 });
  await page.getByLabel("新しい会話", { exact: true }).click();
  const textbox = page.getByRole("textbox", { name: "メッセージ", exact: true });
  await textbox.fill(label);
  await textbox.press("Enter");
  await expect(page.getByText(`了解: ${label}`)).toBeVisible({ timeout: 10000 });
  console.log(`PASS: ${label}: installed cc-manabu opened with the correct token and sent a chat`);
};

try {
  console.log(Bun.spawnSync([chrome, "--version"]).stdout.toString().trim());
  warm = await chromium.launchPersistentContext(directory, {
    executablePath: chrome, headless: false, args: [`--profile-directory=${profile}`],
  });
  const tab = warm.pages()[0] ?? await warm.newPage();
  await tab.goto(origin);
  const manifest = await tab.locator('link[rel="manifest"]').getAttribute("href");
  const manifestResponse = await fetch(new URL(manifest ?? "", origin));
  if ((await manifestResponse.json()).display !== "standalone") throw new Error("Invalid manifest");
  const cdp = await warm.newCDPSession(tab);
  await cdp.send("PWA.install", { manifestId: origin, installUrlOrBundleUrl: origin });
  await cdp.send("PWA.changeAppUserSettings", { manifestId: origin, displayMode: "standalone" });
  await poll(async () => existsSync(join(directory, resourcePath)) ? true : undefined);
  await launch();
  await exercise("Chrome already running");
  const port = server.port;
  await server.stop();
  server = start(port);
  await launch();
  await exercise("server restarted and PWA window already open");
  await warm.close();
  warm = undefined;
  await launch(true);
  const debugPort = await poll(async () => {
    const [value] = (await Bun.file(join(directory, "DevToolsActivePort")).text()).split("\n");
    return Number(value) || undefined;
  });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 10000 });
  await exercise("Chrome cold launch");
} finally {
  await warm?.close().catch(() => {});
  await browser?.close().catch(() => {});
  chromeProcess?.kill();
  await chromeProcess?.exited;
  await server.stop();
  rmSync(directory, { recursive: true, force: true });
}
