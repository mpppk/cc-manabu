import { describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import { helpText, runCli } from "../../src/cli.ts";
import { loadRuntimeConfig } from "../../src/runtime-config.ts";
import { version } from "../../src/version.ts";

const run = async (argv: string[]) => {
  const output: string[] = [];
  const result = await runCli(argv, "cc-manabu", {
    print: (message) => output.push(message),
  });
  return { output, result };
};

describe("runCli", () => {
  test.each([["--version"], ["-v"]])(
    "%s でバージョンを表示する",
    async (flag) => {
      const { output, result } = await run([flag]);
      expect(Result.isSuccess(result)).toBe(true);
      expect(output).toEqual([version]);
    },
  );

  test.each([["--help"], ["-h"], ["help"]])(
    "%s でヘルプを表示する",
    async (flag) => {
      const { output, result } = await run([flag]);
      expect(Result.isSuccess(result)).toBe(true);
      expect(output).toEqual([helpText("cc-manabu")]);
    },
  );

  test("不明なコマンドは UnknownCommandError を返す", async () => {
    const { result } = await run(["unknown"]);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.error.name).toBe("UnknownCommandError");
      expect(result.error.message).toContain("unknown");
    }
  });

  test("update に不明なオプションを渡すと InvalidArgumentsError を返す", async () => {
    const { result } = await run(["update", "--force"]);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.error.name).toBe("InvalidArgumentsError");
    }
  });
});

describe("loadRuntimeConfig", () => {
  test("既定値", () => {
    expect(loadRuntimeConfig({})).toEqual({
      hostname: "127.0.0.1",
      port: 0,
      openBrowser: true,
      requireToken: true,
      chrome: { profile: undefined, appId: undefined },
    });
  });

  test("環境変数でポートとブラウザ起動を変えられる", () => {
    expect(
      loadRuntimeConfig({ CC_MANABU_PORT: "4123", CC_MANABU_NO_OPEN: "1" }),
    ).toEqual({
      hostname: "127.0.0.1",
      port: 4123,
      openBrowser: false,
      requireToken: true,
      chrome: { profile: undefined, appId: undefined },
    });
  });

  test("--pwa が無くても Chrome の指定を読む（インストール済みの PWA を探すのに使う。#163）", () => {
    const config = loadRuntimeConfig({
      CC_MANABU_CHROME_PROFILE: " Profile 2 ",
      CC_MANABU_CHROME_APP_ID: "jceoalhlcmiheiojpbghilhgglnodbme",
    });
    expect(config.pwa).toBeUndefined();
    expect(config.chrome).toEqual({
      profile: "Profile 2",
      appId: "jceoalhlcmiheiojpbghilhgglnodbme",
    });
  });

  test("CC_MANABU_NO_AUTH=1 のときだけトークンを要求しない", () => {
    expect(loadRuntimeConfig({ CC_MANABU_NO_AUTH: "1" }).requireToken).toBe(
      false,
    );
    expect(loadRuntimeConfig({ CC_MANABU_NO_AUTH: "0" }).requireToken).toBe(
      true,
    );
    expect(loadRuntimeConfig({ CC_MANABU_NO_AUTH: "" }).requireToken).toBe(
      true,
    );
  });

  test("--pwa は Chrome の設定を読み、ブラウザを開かない指定とトークン認証を保つ", () => {
    expect(
      loadRuntimeConfig(
        {
          CC_MANABU_PORT: "4000",
          CC_MANABU_CHROME_PROFILE: "Profile 2",
          CC_MANABU_CHROME_APP_ID: "jceoalhlcmiheiojpbghilhgglnodbme",
          CC_MANABU_NO_AUTH: "1",
          CC_MANABU_NO_OPEN: "1",
        },
        true,
      ),
    ).toMatchObject({
      port: 4000,
      openBrowser: false,
      requireToken: true,
      pwa: { profile: "Profile 2", appId: "jceoalhlcmiheiojpbghilhgglnodbme" },
    });
  });

  test("不正なポートは既定値にする", () => {
    expect(loadRuntimeConfig({ CC_MANABU_PORT: "99999" }).port).toBe(0);
    expect(loadRuntimeConfig({ CC_MANABU_PORT: "abc" }).port).toBe(0);
  });
});
