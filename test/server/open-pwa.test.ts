import { describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import { openPwa } from "../../src/server/open-pwa.ts";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = "http://127.0.0.1:4000/#token=launch-token";
const appId = "jceoalhlcmiheiojpbghilhgglnodbme";
const profile = "Profile 2";
const resources = `/Users/test/Library/Application Support/Google/Chrome/${profile}/Web Applications/Manifest Resources/${appId}`;

const setup = (exitCode = 0, paths = [chrome, resources]) => {
  const commands: string[][] = [];
  return {
    commands,
    system: {
      platform: "darwin" as const,
      home: () => "/Users/test",
      exists: (path: string) => paths.includes(path),
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
