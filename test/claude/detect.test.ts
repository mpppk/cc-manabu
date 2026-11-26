import { describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import {
  parseClaudeVersion,
  probeClaude,
  resolveClaudePath,
} from "../../src/claude/detect.ts";
import { createClaudeStatus } from "../../src/claude/status.ts";

describe("resolveClaudePath", () => {
  const which = (found: string | null) => () => found;
  test("MONET_CLAUDE_PATH（改名前の CC_MANABU_CLAUDE_PATH）を優先する", () => {
    expect(
      resolveClaudePath({
        env: { MONET_CLAUDE_PATH: "/opt/claude" },
        which: which("/usr/bin/claude"),
        exists: () => true,
      }),
    ).toEqual(Result.succeed("/opt/claude"));
    expect(
      resolveClaudePath({
        env: { CC_MANABU_CLAUDE_PATH: "/legacy/claude" },
        which: which("/usr/bin/claude"),
        exists: () => true,
      }),
    ).toEqual(Result.succeed("/legacy/claude"));
  });
  test("指定したパスが無ければエラー（PATH は探さない）", () => {
    const result = resolveClaudePath({
      env: { MONET_CLAUDE_PATH: "/nope" },
      which: which("/usr/bin/claude"),
      exists: () => false,
    });
    expect(Result.isFailure(result) && result.error.message).toContain("/nope");
  });
  test("PATH 上の claude を使う。無ければ ClaudeNotInstalledError", () => {
    expect(
      resolveClaudePath({
        env: {},
        which: which("/usr/bin/claude"),
        exists: () => true,
      }),
    ).toEqual(Result.succeed("/usr/bin/claude"));
    const missing = resolveClaudePath({
      env: {},
      which: which(null),
      exists: () => true,
    });
    expect(Result.isFailure(missing) && missing.error.name).toBe(
      "ClaudeNotInstalledError",
    );
  });
});

describe("parseClaudeVersion", () => {
  test.each([
    ["2.1.330 (Claude Code)\n", "2.1.330"],
    ["claude 1.0.0", "1.0.0"],
    ["unknown", undefined],
  ])("%s", (output, expected) => {
    expect(parseClaudeVersion(output)).toBe(expected);
  });
});

describe("probeClaude", () => {
  const fakeQuery = (account: Record<string, unknown>) => {
    let returned = false;
    return {
      query: () => ({
        supportedModels: async () => [
          { value: "sonnet", displayName: "Sonnet", description: "" },
        ],
        accountInfo: async () => account,
        return: async () => {
          returned = true;
          return { done: true as const, value: undefined };
        },
      }),
      get returned() {
        return returned;
      },
    };
  };

  test("モデル一覧とアカウント情報を返し、メールアドレスと組織名は含めない", async () => {
    const fake = fakeQuery({
      email: "someone@example.com",
      organization: "Org",
      subscriptionType: "Claude Max",
      apiProvider: "firstParty",
    });
    const result = await probeClaude("/bin/claude", {
      query: fake.query as never,
    });
    expect(result).toEqual(
      Result.succeed({
        models: [{ value: "sonnet", displayName: "Sonnet", description: "" }],
        account: {
          subscriptionType: "Claude Max",
          tokenSource: undefined,
          apiKeySource: undefined,
          apiProvider: "firstParty",
        },
      }),
    );
    expect(JSON.stringify(result)).not.toContain("someone@example.com");
    expect(fake.returned).toBe(true);
  });

  test("応答が無ければタイムアウトで ClaudeProbeError", async () => {
    const result = await probeClaude("/bin/claude", {
      timeoutMs: 10,
      query: (() => ({
        supportedModels: () => new Promise(() => {}),
        accountInfo: () => new Promise(() => {}),
        return: async () => ({ done: true, value: undefined }),
      })) as never,
    });
    expect(Result.isFailure(result) && result.error.name).toBe(
      "ClaudeProbeError",
    );
  });
});

describe("createClaudeStatus", () => {
  test("見つからなければ not_installed", () => {
    expect(
      createClaudeStatus({ found: false, message: "missing" }).get(),
    ).toEqual({ state: "not_installed", message: "missing" });
  });

  test("調べ終わるまでは checking、成功すれば ready", async () => {
    const status = createClaudeStatus(
      { found: true, path: "/bin/claude" },
      {
        version: async () => "2.1.330",
        probe: async () =>
          Result.succeed({
            models: [],
            account: { subscriptionType: "Claude Pro" },
          }),
      },
    );
    expect(status.get().state).toBe("checking");
    await status.ready;
    expect(status.get()).toEqual({
      state: "ready",
      path: "/bin/claude",
      version: "2.1.330",
      models: [],
      account: { subscriptionType: "Claude Pro" },
    });
  });

  test("情報を取れなければ error と、ログインの案内", async () => {
    const status = createClaudeStatus(
      { found: true, path: "/bin/claude" },
      {
        version: async () => undefined,
        probe: async () => Result.fail(new Error("boom")),
      },
    );
    await status.ready;
    expect(status.get()).toMatchObject({
      state: "error",
      message: expect.stringContaining("ログイン"),
    });
  });
});
