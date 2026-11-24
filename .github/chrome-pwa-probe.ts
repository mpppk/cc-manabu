import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";

const profile = mkdtempSync(join(tmpdir(), "cc-manabu-chrome-probe-"));
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const manifest = {
  id: "/", start_url: "/", scope: "/", display: "standalone", name: "cc-manabu launch probe",
  icons: [
    { src: "/icon192.svg", sizes: "192x192", type: "image/svg+xml" },
    { src: "/icon512.svg", sizes: "512x512", type: "image/svg+xml" },
  ],
};
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  routes: {
    "/manifest.webmanifest": Response.json(manifest),
    "/:icon": (req) => new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${req.url.includes("192") ? 192 : 512}" height="${req.url.includes("192") ? 192 : 512}" viewBox="0 0 24 24"><rect width="24" height="24" fill="#232E31"/></svg>`,
      { headers: { "content-type": "image/svg+xml" } },
    ),
    "/": new Response('<!doctype html><meta charset="utf-8"><link rel="manifest" href="/manifest.webmanifest"><title>Launch probe</title><script>function show(){document.documentElement.dataset.token=location.hash.slice(7)}window.addEventListener("hashchange",show);show();</script>', { headers: { "content-type": "text/html; charset=utf-8" } }),
  },
});
const url = server.url.href;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest();
const id = Array.from(hash(hash(url)).subarray(0, 16).toString("hex"), (hex) =>
  String.fromCharCode(97 + Number.parseInt(hex, 16))).join("");
const launchArgs = (value: string) => [
  `--app-id=${id}`,
  `--app-launch-url-for-shortcuts-menu-item=${url}#token=${value}`,
];
const profileArgs = [`--user-data-dir=${profile}`, "--profile-directory=Default"];
const start = (args: string[]) => Bun.spawn([
  chrome, ...profileArgs, "--remote-debugging-port=0",
  "--no-first-run", "--no-default-browser-check", ...args,
], { stdout: "ignore", stderr: "ignore" });
let process: ReturnType<typeof start> | undefined;
let browser: Browser | undefined;
let warmContext: BrowserContext | undefined;
const poll = async <T>(get: () => Promise<T | undefined>): Promise<T> => {
  for (let i = 0; i < 80; i++) {
    const value = await get().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(250);
  }
  throw new Error("Timed out");
};
const connect = async () => {
  const port = await poll(async () => {
    const [value] = (await Bun.file(join(profile, "DevToolsActivePort")).text()).split("\n");
    return Number(value) || undefined;
  });
  const result = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
  const cdp = await result.newBrowserCDPSession();
  return { result, cdp };
};
const quit = async () => {
  if (browser) {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send("Browser.close").catch(() => {});
    await browser.close().catch(() => {});
  }
  if (process) await process.exited;
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
};
const waitApp = async (value: string) => {
  const result = await poll(async () => {
    for (const page of warmContext?.pages() ?? browser?.contexts().flatMap((c) => c.pages()) ?? []) {
      if (!page.url().startsWith(url)) continue;
      const app = await page.evaluate(() => ({
        standalone: matchMedia("(display-mode: standalone)").matches,
        token: document.documentElement.dataset.token,
      }));
      if (app.standalone && app.token === value) return page;
    }
    return undefined;
  });
  console.log(`PASS ${value}: standalone window received the launch URL`);
  return result;
};
try {
  console.log(Bun.spawnSync([chrome, "--version"]).stdout.toString().trim());
  warmContext = await chromium.launchPersistentContext(profile, {
    executablePath: chrome, headless: false, args: ["--profile-directory=Default"],
  });
  const tab = warmContext.pages()[0] ?? await warmContext.newPage();
  await tab.goto(url);
  const cdp = await warmContext.newCDPSession(tab);
  await cdp.send("PWA.install", { manifestId: url, installUrlOrBundleUrl: url });
  await cdp.send("PWA.changeAppUserSettings", { manifestId: url, displayMode: "standalone" });
  await poll(async () => existsSync(join(profile, "Default", "Web Applications", "Manifest Resources", id)) ? true : undefined);
  console.log("PASS installation: verified the generated app ID and profile directory");
  const warmLaunch = Bun.spawn([chrome, ...profileArgs, ...launchArgs("chrome-already-running")], { stdout: "ignore", stderr: "ignore" });
  const app = await waitApp("chrome-already-running");
  console.log(`Warm launcher exit code: ${await warmLaunch.exited}`);
  const repeat = Bun.spawn([chrome, ...profileArgs, ...launchArgs("app-already-open")], { stdout: "ignore", stderr: "ignore" });
  const relaunched = await waitApp("app-already-open");
  console.log(`PWA window reused: ${relaunched === app}; launcher exit code: ${await repeat.exited}`);
  await warmContext.close();
  warmContext = undefined;
  process = start(launchArgs("cold-chrome"));
  browser = (await connect()).result;
  await waitApp("cold-chrome");
  await quit();
} finally {
  await warmContext?.close().catch(() => {});
  process?.kill();
  server.stop(true);
  rmSync(profile, { recursive: true, force: true });
}
