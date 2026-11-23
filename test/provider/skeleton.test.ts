import { describe, expect, test } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import {
  collectWarnings,
  readCallOptions,
  toEffort,
} from "../../src/provider/call-options.ts";
import { createClaudeCode, PROVIDER_NAME } from "../../src/provider/index.ts";

const baseOptions: LanguageModelV4CallOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

describe("createClaudeCode", () => {
  test("LanguageModelV4 を返す", () => {
    const claudeCode = createClaudeCode();
    const model = claudeCode("sonnet");
    expect(model.specificationVersion).toBe("v4");
    expect(model.provider).toBe(PROVIDER_NAME);
    expect(model.modelId).toBe("sonnet");
    expect(claudeCode.languageModel("haiku").modelId).toBe("haiku");
  });

  test("provider の設定がモデルに渡る", () => {
    const model = createClaudeCode({ cwd: "/work" })("opus");
    expect(model.settings.cwd).toBe("/work");
  });
});

describe("collectWarnings", () => {
  test("何も指定しなければ warning は無い", () => {
    expect(collectWarnings(baseOptions)).toEqual([]);
  });

  test("Claude Code で効かない設定には unsupported を返す", () => {
    const warnings = collectWarnings({
      ...baseOptions,
      temperature: 0.5,
      maxOutputTokens: 100,
      tools: [
        {
          type: "function",
          name: "weather",
          inputSchema: { type: "object" },
        },
      ],
      toolChoice: { type: "required" },
      responseFormat: { type: "json" },
    });
    expect(warnings.map((w) => w.type === "unsupported" && w.feature)).toEqual([
      "maxOutputTokens",
      "temperature",
      "tools",
      "toolChoice",
      "responseFormat",
    ]);
  });

  test("toolChoice: auto と responseFormat: text は警告しない", () => {
    expect(
      collectWarnings({
        ...baseOptions,
        toolChoice: { type: "auto" },
        responseFormat: { type: "text" },
      }),
    ).toEqual([]);
  });
});

describe("toEffort", () => {
  test.each([
    [undefined, { thinkingDisabled: false }],
    ["provider-default", { thinkingDisabled: false }],
    ["none", { thinkingDisabled: true }],
    ["minimal", { effort: "low", thinkingDisabled: false }],
    ["high", { effort: "high", thinkingDisabled: false }],
    ["max", { effort: "max", thinkingDisabled: false }],
  ] as const)("%s", (reasoning, expected) => {
    expect(toEffort(reasoning)).toEqual(expected);
  });
});

describe("readCallOptions", () => {
  test("providerOptions から取り出す", () => {
    expect(
      readCallOptions({
        ...baseOptions,
        providerOptions: {
          [PROVIDER_NAME]: {
            sessionId: "s1",
            resumeSessionAt: "u1",
            forkSession: true,
          },
        },
      }),
    ).toEqual({ sessionId: "s1", resumeSessionAt: "u1", forkSession: true });
  });

  test("型が違う値は無視する", () => {
    expect(
      readCallOptions({
        ...baseOptions,
        providerOptions: {
          [PROVIDER_NAME]: { sessionId: 1, forkSession: "yes" },
        },
      }),
    ).toEqual({
      sessionId: undefined,
      resumeSessionAt: undefined,
      forkSession: false,
    });
  });
});
