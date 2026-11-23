import { describe, expect, test } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Result } from "@praha/byethrow";
import {
  buildQueryOptions,
  extractLatestUserText,
} from "../../src/provider/convert-prompt.ts";
import { PROVIDER_NAME } from "../../src/provider/types.ts";

describe("extractLatestUserText", () => {
  test("末尾のユーザー発話のテキストだけを返す", () => {
    const result = extractLatestUserText([
      { role: "user", content: [{ type: "text", text: "1 回目" }] },
      { role: "assistant", content: [{ type: "text", text: "返答" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "2 回目" },
          { type: "text", text: "続き" },
        ],
      },
    ]);
    expect(result).toEqual(
      Result.succeed({ text: "2 回目\n\n続き", warnings: [] }),
    );
  });

  test("テキスト以外のパーツと system メッセージは warning にする", () => {
    const result = extractLatestUserText([
      { role: "system", content: "you are helpful" },
      {
        role: "user",
        content: [
          { type: "text", text: "これは？" },
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: new Uint8Array([1]) },
          },
        ],
      },
    ]);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.value.text).toBe("これは？");
      expect(result.value.warnings.map((w) => w.type)).toEqual([
        "unsupported",
        "unsupported",
      ]);
    }
  });

  test("末尾がユーザー発話でなければ NoUserMessageError", () => {
    const result = extractLatestUserText([
      { role: "assistant", content: [{ type: "text", text: "返答" }] },
    ]);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.error.name).toBe("NoUserMessageError");
    }
  });
});

describe("buildQueryOptions", () => {
  const callOptions: LanguageModelV4CallOptions = {
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
  const abortController = new AbortController();

  test("既定値", () => {
    const options = buildQueryOptions({
      modelId: "sonnet",
      settings: { cwd: "/work" },
      callOptions,
      abortController,
    });
    expect(options).toEqual({
      abortController,
      includePartialMessages: true,
      model: "sonnet",
      cwd: "/work",
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      thinking: { type: "adaptive", display: "summarized" },
    });
  });

  test("default モデルは model を指定しない", () => {
    const options = buildQueryOptions({
      modelId: "default",
      settings: {},
      callOptions,
      abortController,
    });
    expect(options.model).toBeUndefined();
  });

  test("provider の設定を反映する", () => {
    const canUseTool = async () => ({ behavior: "deny" as const, message: "" });
    const options = buildQueryOptions({
      modelId: "opus",
      settings: {
        cwd: "/work",
        pathToClaudeCodeExecutable: "/bin/claude",
        settingSources: ["user"],
        appendSystemPrompt: "日本語で答えて",
        canUseTool,
        permissionMode: "acceptEdits",
        env: { PATH: "/bin" },
      },
      callOptions,
      abortController,
    });
    expect(options).toMatchObject({
      pathToClaudeCodeExecutable: "/bin/claude",
      settingSources: ["user"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "日本語で答えて",
      },
      canUseTool,
      permissionMode: "acceptEdits",
      env: { PATH: "/bin" },
    });
  });

  test("reasoning を effort と thinking に変換する", () => {
    expect(
      buildQueryOptions({
        modelId: "sonnet",
        settings: {},
        callOptions: { ...callOptions, reasoning: "high" },
        abortController,
      }),
    ).toMatchObject({
      effort: "high",
      thinking: { type: "adaptive", display: "summarized" },
    });
    expect(
      buildQueryOptions({
        modelId: "sonnet",
        settings: {},
        callOptions: { ...callOptions, reasoning: "none" },
        abortController,
      }).thinking,
    ).toEqual({ type: "disabled" });
  });

  test("sessionId があれば resume し、分岐の指定も渡す", () => {
    const options = buildQueryOptions({
      modelId: "sonnet",
      settings: {},
      callOptions: {
        ...callOptions,
        providerOptions: {
          [PROVIDER_NAME]: {
            sessionId: "s1",
            resumeSessionAt: "u1",
            forkSession: true,
          },
        },
      },
      abortController,
    });
    expect(options).toMatchObject({
      resume: "s1",
      resumeSessionAt: "u1",
      forkSession: true,
    });
  });

  test("sessionId が無ければ resumeSessionAt と forkSession は無視する", () => {
    const options = buildQueryOptions({
      modelId: "sonnet",
      settings: {},
      callOptions: {
        ...callOptions,
        providerOptions: {
          [PROVIDER_NAME]: { resumeSessionAt: "u1", forkSession: true },
        },
      },
      abortController,
    });
    expect(options.resume).toBeUndefined();
    expect(options.resumeSessionAt).toBeUndefined();
    expect(options.forkSession).toBeUndefined();
  });
});
