import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Result } from "@praha/byethrow";
import { runCli } from "../src/cli.ts";
import {
  assetNameFor,
  compareVersions,
  findChecksum,
  isRunningFromSource,
  sha256,
  update,
} from "../src/update.ts";

describe("compareVersions", () => {
  test.each([
    ["1.0.0", "0.9.9", 1],
    ["0.2.0", "0.10.0", -1],
    ["v1.2.3", "1.2.3", 0],
    ["1.0.0", "1.0.0-beta.1", 1],
    ["1.0.0-beta.1", "1.0.0", -1],
    ["1.0.0-beta.2", "1.0.0-beta.1", 1],
  ])("%s と %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});

describe("assetNameFor", () => {
  test.each([
    ["linux", "x64", "monet-linux-x64.tar.gz"],
    ["linux", "arm64", "monet-linux-arm64.tar.gz"],
    ["darwin", "arm64", "monet-darwin-arm64.tar.gz"],
    ["win32", "x64", "monet-windows-x64.zip"],
  ])("%s-%s", (platform, arch, expected) => {
    expect(assetNameFor(platform, arch)).toEqual(Result.succeed(expected));
  });

  test("対応していないプラットフォーム", () => {
    const result = assetNameFor("darwin", "x64");
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.error.name).toBe("UnsupportedPlatformError");
    }
  });
});

test("findChecksum は sha256sum の出力を読む", () => {
  const checksums = "aaa  monet-linux-x64.tar.gz\nbbb *monet-windows-x64.zip\n";
  expect(findChecksum(checksums, "monet-linux-x64.tar.gz")).toBe("aaa");
  expect(findChecksum(checksums, "monet-windows-x64.zip")).toBe("bbb");
  expect(findChecksum(checksums, "missing")).toBeUndefined();
});

test("isRunningFromSource", () => {
  expect(isRunningFromSource("/home/me/.bun/bin/bun")).toBe(true);
  expect(isRunningFromSource("C:\\bun\\bun.exe")).toBe(true);
  expect(isRunningFromSource("/usr/local/bin/monet")).toBe(false);
});

describe("update", () => {
  let dir: string;
  let execPath: string;
  let archive: ArrayBuffer;
  const assetName = "monet-linux-x64.tar.gz";

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "monet-update-test-"));
    // 新しいバージョンのバイナリを tar.gz にする
    const build = path.join(dir, "build");
    await mkdir(build);
    await Bun.write(path.join(build, "monet"), "new binary");
    const tar = Bun.spawnSync(["tar", "czf", assetName, "monet"], {
      cwd: build,
    });
    expect(tar.exitCode).toBe(0);
    archive = await Bun.file(path.join(build, assetName)).arrayBuffer();
    execPath = path.join(dir, "bin", "monet");
    await Bun.write(execPath, "old binary");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fakeFetch =
    (options: { tag?: string; checksum?: string } = {}) =>
    async (url: string): Promise<Response> => {
      const base = `https://github.com/mpppk/monet/releases/download/${options.tag ?? "v0.2.0"}`;
      if (url.endsWith("/releases/latest")) {
        // リダイレクト後の URL（/releases/tag/<tag>）を再現する
        const response = new Response("");
        Object.defineProperty(response, "url", {
          value: `https://github.com/mpppk/monet/releases/tag/${options.tag ?? "v0.2.0"}`,
        });
        return response;
      }
      if (url === `${base}/checksums.txt`) {
        return new Response(
          `${options.checksum ?? sha256(archive)}  ${assetName}\n`,
        );
      }
      if (url === `${base}/${assetName}`) {
        return new Response(archive);
      }
      return new Response("not found", { status: 404 });
    };

  const run = (fetch: (url: string) => Promise<Response>, current = "0.1.0") =>
    update({
      currentVersion: current,
      execPath,
      platform: "linux",
      arch: "x64",
      fetch,
      log: () => {},
    });

  test("新しいリリースがあればバイナリを置き換える", async () => {
    const result = await run(fakeFetch());
    expect(result).toEqual(
      Result.succeed({ kind: "updated", from: "0.1.0", to: "0.2.0" }),
    );
    expect(await readFile(execPath, "utf8")).toBe("new binary");
    expect((await stat(execPath)).mode & 0o111).not.toBe(0);
  });

  test("最新版なら何もしない", async () => {
    const result = await run(fakeFetch({ tag: "v0.1.0" }), "0.1.0");
    expect(result).toEqual(
      Result.succeed({ kind: "up-to-date", version: "0.1.0" }),
    );
    expect(await readFile(execPath, "utf8")).toBe("old binary");
  });

  test("チェックサムが一致しなければ置き換えない", async () => {
    const result = await run(fakeFetch({ checksum: "0".repeat(64) }));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.error.name).toBe("ChecksumMismatchError");
    }
    expect(await readFile(execPath, "utf8")).toBe("old binary");
  });

  test("リリースの取得に失敗したら UpdateFetchError", async () => {
    const result = await run(async () => new Response("", { status: 500 }));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.error.name).toBe("UpdateFetchError");
      expect(result.error.message).toContain("HTTP 500");
    }
  });

  test("bun で実行中なら RunningFromSourceError", async () => {
    const result = await update({
      currentVersion: "0.1.0",
      execPath: "/usr/local/bin/bun",
      platform: "linux",
      arch: "x64",
      fetch: fakeFetch(),
      log: () => {},
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.error.name).toBe("RunningFromSourceError");
    }
  });
});

describe("monet update", () => {
  test("更新結果を表示する", async () => {
    const output: string[] = [];
    const result = await runCli(["update"], "monet", {
      print: (message) => output.push(message),
      update: async (log) => {
        log("v0.1.0 → v0.2.0 に更新します…");
        return Result.succeed({ kind: "updated", from: "0.1.0", to: "0.2.0" });
      },
    });
    expect(Result.isSuccess(result)).toBe(true);
    expect(output).toEqual([
      "v0.1.0 → v0.2.0 に更新します…",
      "v0.2.0 に更新しました。",
    ]);
  });

  test("最新版ならそう表示する", async () => {
    const output: string[] = [];
    await runCli(["update"], "monet", {
      print: (message) => output.push(message),
      update: async () =>
        Result.succeed({ kind: "up-to-date", version: "0.1.0" }),
    });
    expect(output).toEqual(["最新版（v0.1.0）です。"]);
  });
});
