import { describe, expect, test } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Result } from "@praha/byethrow";
import {
  buildQueryOptions,
  extractLatestUserPrompt,
  toQueryPrompt,
} from "../../src/provider/convert-prompt.ts";
import { PROVIDER_NAME } from "../../src/provider/types.ts";

describe("extractLatestUserPrompt", () => {
  test("末尾のユーザー発話のテキストだけを返す", () => {
    const result = extractLatestUserPrompt([
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
      Result.succeed({ text: "2 回目\n\n続き", images: [], warnings: [] }),
    );
  });

  test("画像の file パーツを base64 の画像にする", () => {
    const result = extractLatestUserPrompt([
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: new Uint8Array([1, 2, 3]) },
          },
          {
            type: "file",
            mediaType: "image/jpeg",
            data: { type: "data", data: "QUJD" },
          },
          {
            type: "file",
            mediaType: "image/webp",
            data: { type: "url", url: new URL("data:image/webp;base64,WFla") },
          },
          { type: "text", text: "これは？" },
        ],
      },
    ]);
    expect(result).toEqual(
      Result.succeed({
        text: "これは？",
        images: [
          { mediaType: "image/png", base64: "AQID" },
          { mediaType: "image/jpeg", base64: "QUJD" },
          { mediaType: "image/webp", base64: "WFla" },
        ],
        warnings: [],
      }),
    );
  });

  test("送れないパーツと system メッセージは warning にする", () => {
    const result = extractLatestUserPrompt([
      { role: "system", content: "you are helpful" },
      {
        role: "user",
        content: [
          { type: "text", text: "これは？" },
          {
            type: "file",
            mediaType: "application/pdf",
            data: { type: "data", data: new Uint8Array([1]) },
          },
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "url", url: new URL("https://example.com/a.png") },
          },
        ],
      },
    ]);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.value.text).toBe("これは？");
      expect(result.value.images).toEqual([]);
      expect(result.value.warnings.map((w) => w.type)).toEqual([
        "unsupported",
        "unsupported",
        "unsupported",
      ]);
    }
  });

  test("末尾がユーザー発話でなければ NoUserMessageError", () => {
    const result = extractLatestUserPrompt([
      { role: "assistant", content: [{ type: "text", text: "返答" }] },
    ]);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.error.name).toBe("NoUserMessageError");
    }
  });
});

describe("toQueryPrompt", () => {
  test("画像が無ければ文字列", () => {
    expect(toQueryPrompt({ text: "hi", images: [] })).toBe("hi");
  });

  test("画像があれば、画像ブロックとテキストを持つユーザーメッセージを 1 つ流す", async () => {
    const prompt = toQueryPrompt({
      text: "これは？",
      images: [{ mediaType: "image/png", base64: "AQID" }],
    });
    expect(typeof prompt).not.toBe("string");
    const messages = [];
    for await (const message of prompt as AsyncIterable<unknown>) {
      messages.push(message);
    }
    expect(messages).toEqual([
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AQID" },
            },
            { type: "text", text: "これは？" },
          ],
        },
      },
    ]);
  });

  test("参照資料があれば、質問の前に別のブロックとして渡す", async () => {
    const prompt = toQueryPrompt({
      text: "質問",
      images: [],
      context: "参照資料",
    }) as AsyncIterable<{ message: { content: unknown[] } }>;
    const contents = [];
    for await (const message of prompt) {
      contents.push(message.message.content);
    }
    expect(contents).toEqual([
      [
        { type: "text", text: "参照資料" },
        { type: "text", text: "質問" },
      ],
    ]);
    expect(toQueryPrompt({ text: "質問", images: [], context: "  " })).toBe(
      "質問",
    );
  });

  test("本文が空なら画像だけ", async () => {
    const prompt = toQueryPrompt({
      text: "",
      images: [{ mediaType: "image/gif", base64: "R0lG" }],
    }) as AsyncIterable<{ message: { content: { type: string }[] } }>;
    for await (const message of prompt) {
      expect(message.message.content.map((block) => block.type)).toEqual([
        "image",
      ]);
    }
  });
});

describe("buildQueryOptions（軽い呼び出し）", () => {
  test("systemPrompt・tools・persistSession・maxTurns を渡せる", () => {
    const options = buildQueryOptions({
      modelId: "haiku",
      settings: {
        cwd: "/work",
        systemPrompt: "用語を抽出する",
        appendSystemPrompt: "使われない",
        tools: [],
        persistSession: false,
        maxTurns: 1,
      },
      callOptions: {
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      abortController: new AbortController(),
    });
    expect(options).toMatchObject({
      systemPrompt: "用語を抽出する",
      tools: [],
      persistSession: false,
      maxTurns: 1,
    });
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
