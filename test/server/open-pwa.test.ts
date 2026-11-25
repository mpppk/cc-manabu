import { describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import { openPwa } from "../../src/server/open-pwa.ts";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = "http://127.0.0.1:4000/#token=launch-token";
const appId = "jceoalhlcmiheiojpbghilhgglnodbme";
const profile = "Profile 2";
const userData = "/Users/test/Library/Application Support/Google/Chrome";
const resourcesIn = (name: string) =>
  `${userData}/${name}/Web Applications/Manifest Resources/${appId}`;
const resources = resourcesIn(profile);

const setup = (
  exitCode = 0,
  paths = [chrome, resources],
  entries = [
    "Default",
    "Local State",
    "Profile 10",
    "Profile 2",
    "System Profile",
  ],
) => {
  const commands: string[][] = [];
  return {
    commands,
    system: {
      platform: "darwin" as const,
      home: () => "/Users/test",
      exists: (path: string) => paths.includes(path),
      list: (path: string) => (path === userData ? entries : []),
      spawn: async (command: string[]) => {
        commands.push(command);
        return exitCode;
      },
    },
  };
};

describe("openPwa", () => {
  test("指定したプロファイルのアプリに起動トークン付き URL を渡す", async () => {
    const { system, commands } = setup();
    const result = await openPwa(url, { profile, appId: undefined }, system);
    expect(Result.isSuccess(result)).toBe(true);
    expect(commands).toEqual([
      [
        chrome,
        "--profile-directory=Profile 2",
        `--app-id=${appId}`,
        `--app-launch-url-for-shortcuts-menu-item=${url}`,
      ],
    ]);
  });

  test("プロファイルを指定しなければ、インストールしたプロファイルを探す", async () => {
    for (const [paths, expected] of [
      [[chrome, resources], "Profile 2"],
      [[chrome, resourcesIn("Profile 10"), resources], "Profile 2"],
      [[chrome, resources, resourcesIn("Default")], "Default"],
    ] as const) {
      const { system, commands } = setup(0, [...paths]);
      const result = await openPwa(
        url,
        { profile: undefined, appId: undefined },
        system,
      );
      expect(Result.isSuccess(result)).toBe(true);
      expect(commands[0]?.[1]).toBe(`--profile-directory=${expected}`);
    }

    const { system, commands } = setup(0, [
      chrome,
      resourcesIn("System Profile"),
    ]);
    const result = await openPwa(
      url,
      { profile: undefined, appId: undefined },
      system,
    );
    expect(Result.isFailure(result) && result.error.message).toBe(
      "Chrome のどのプロファイルにも cc-manabu が見つかりません。http://127.0.0.1:4000/ からインストールしてください。",
    );
    expect(commands).toEqual([]);
  });

  test("Chrome、インストール、または対象ポートが一致しなければ起動しない", async () => {
    const { system, commands } = setup();
    for (const [overrides, id, reason] of [
      [setup(0, []).system, undefined, "Google Chrome が"],
      [setup(0, [chrome]).system, undefined, "cc-manabu が見つかりません"],
      [system, "a".repeat(32), "起動 URL と一致しません"],
    ] as const) {
      const result = await openPwa(url, { profile, appId: id }, overrides);
      expect(Result.isFailure(result) && result.error.message).toContain(
        reason,
      );
    }
    expect(commands).toEqual([]);
  });

  test("Chrome が異常終了したらトークンを含まない理由を返す", async () => {
    const { system } = setup(1);
    const result = await openPwa(url, { profile, appId }, system);
    expect(Result.isFailure(result) && result.error.message).toBe(
      "Google Chrome の起動に失敗しました（終了コード 1）。",
    );
  });
});
