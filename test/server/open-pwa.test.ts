import { describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import {
  chromeAppId,
  findInstalledPwa,
  openPwa,
} from "../../src/server/open-pwa.ts";

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
      "Chrome のどのプロファイルにも monet が見つかりません。http://127.0.0.1:4000/ からインストールしてください。",
    );
    expect(commands).toEqual([]);
  });

  test("Chrome、インストール、または対象ポートが一致しなければ起動しない", async () => {
    const { system, commands } = setup();
    for (const [overrides, id, reason] of [
      [setup(0, []).system, undefined, "Google Chrome が"],
      [setup(0, [chrome]).system, undefined, "monet が見つかりません"],
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

describe("findInstalledPwa（#163）", () => {
  const manifestResources = (name: string) =>
    `${userData}/${name}/Web Applications/Manifest Resources`;
  const appIdFor = (port: number) => chromeAppId(`http://127.0.0.1:${port}/`);
  /** プロファイルごとにインストールしたアプリの ID。 */
  const chromeWith = (
    installed: Record<string, string[]>,
    platform: NodeJS.Platform = "darwin",
  ) => ({
    platform,
    home: () => "/Users/test",
    exists: (path: string) => path === chrome,
    list: (path: string) =>
      path === userData
        ? ["Local State", ...Object.keys(installed)]
        : (Object.entries(installed).find(
            ([name]) => manifestResources(name) === path,
          )?.[1] ?? []),
  });
  const none = { port: 0, profile: undefined, appId: undefined };

  test("4000 番のアプリ ID は既知の値と一致する", () => {
    expect(appIdFor(4000)).toBe(appId);
  });

  test("ポートの指定が無ければ、インストール時のポートを見つける", () => {
    const result = findInstalledPwa(
      none,
      chromeWith({ Default: ["other-app"], "Profile 2": [appIdFor(4000)] }),
    );
    expect(result).toEqual(
      Result.succeed({ port: 4000, profile: "Profile 2", appId }),
    );
  });

  test("ポートの指定があれば、そのポートの PWA だけを照合する", () => {
    const system = chromeWith({ Default: [appIdFor(4000), appIdFor(4100)] });
    expect(findInstalledPwa({ ...none, port: 4100 }, system)).toEqual(
      Result.succeed({
        port: 4100,
        profile: "Default",
        appId: appIdFor(4100),
      }),
    );
    expect(findInstalledPwa({ ...none, port: 4200 }, system)).toEqual(
      Result.succeed(undefined),
    );
  });

  test("候補のポートが複数あれば、ポートの指定を案内する", () => {
    const result = findInstalledPwa(
      none,
      chromeWith({ Default: [appIdFor(4000)], "Profile 2": [appIdFor(4100)] }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.error.message).toContain("4000、4100");
      expect(result.error.message).toContain("MONET_PORT");
    }
  });

  test("プロファイルとアプリ ID の指定で絞る", () => {
    const system = chromeWith({
      Default: [appIdFor(4000)],
      "Profile 2": [appIdFor(4100)],
    });
    expect(findInstalledPwa({ ...none, profile: "Profile 2" }, system)).toEqual(
      Result.succeed({
        port: 4100,
        profile: "Profile 2",
        appId: appIdFor(4100),
      }),
    );
    expect(
      findInstalledPwa({ ...none, appId: appIdFor(4000) }, system),
    ).toEqual(Result.succeed({ port: 4000, profile: "Default", appId }));
  });

  test("未インストール・対応していない環境では見つからない", () => {
    expect(findInstalledPwa(none, chromeWith({ Default: [] }))).toEqual(
      Result.succeed(undefined),
    );
    expect(
      findInstalledPwa(none, chromeWith({ Default: [appId] }, "linux")),
    ).toEqual(Result.succeed(undefined));
    expect(
      findInstalledPwa(none, {
        ...chromeWith({ Default: [appId] }),
        exists: () => false,
      }),
    ).toEqual(Result.succeed(undefined));
  });
});
