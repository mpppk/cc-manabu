import { describe, expect, test } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { readUIMessageStream, streamText, type UIMessage } from "ai";
import { createClaudeCode, PROVIDER_NAME } from "../../src/provider/index.ts";
import { createFakeQuery, loadFixture } from "./fake-query.ts";

const setup = async (fixture: string) => {
  const { query, calls } = createFakeQuery(await loadFixture(fixture));
  const model = createClaudeCode({ cwd: "/work", query })("haiku");
  return { model, calls };
};

const collectParts = async (
  stream: ReadableStream<LanguageModelV4StreamPart>,
) => {
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return parts;
};

const lastUIMessage = async (
  result: ReturnType<typeof streamText>,
): Promise<UIMessage | undefined> => {
  let message: UIMessage | undefined;
  for await (const m of readUIMessageStream({
    stream: result.toUIMessageStream(),
  })) {
    message = m;
  }
  return message;
};

const prompt = "hi";

describe("doStream", () => {
  test("末尾のユーザー発話だけを query() に渡す", async () => {
    const { model, calls } = await setup("text-partial");
    const result = streamText({
      model,
      messages: [
        { role: "user", content: "1 回目" },
        { role: "assistant", content: "返答" },
        { role: "user", content: "2 回目" },
      ],
    });
    await result.consumeStream();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("2 回目");
    expect(calls[0]?.options).toMatchObject({
      model: "haiku",
      cwd: "/work",
      includePartialMessages: true,
    });
  });

  test("画像付きの発話は、画像ブロックを含むユーザーメッセージとして渡す", async () => {
    const { model, calls } = await setup("text-partial");
    const result = streamText({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "image/png",
              data: "data:image/png;base64,iVBORw0KGgo=",
            },
            { type: "text", text: "これは？" },
          ],
        },
      ],
    });
    await result.consumeStream();
    const messages: unknown[] = [];
    const sent = calls[0]?.prompt as AsyncIterable<unknown>;
    for await (const message of sent) {
      messages.push(message);
    }
    expect(messages).toEqual([
      expect.objectContaining({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgo=",
              },
            },
            { type: "text", text: "これは？" },
          ],
        },
      }),
    ]);
  });

  test("providerOptions の context は質問とは別のブロックで渡す", async () => {
    const { model, calls } = await setup("text-partial");
    const result = streamText({
      model,
      prompt: "質問",
      providerOptions: { [PROVIDER_NAME]: { context: "参照資料" } },
    });
    await result.consumeStream();
    const sent = calls[0]?.prompt as AsyncIterable<{
      message: { content: unknown };
    }>;
    const contents: unknown[] = [];
    for await (const message of sent) {
      contents.push(message.message.content);
    }
    expect(contents).toEqual([
      [
        { type: "text", text: "参照資料" },
        { type: "text", text: "質問" },
      ],
    ]);
  });

  test("テキストの応答（text-partial）", async () => {
    const { model } = await setup("text-partial");
    const result = streamText({ model, prompt });
    expect(await result.text).toBe("こんにちは");
    expect(await result.finishReason).toBe("stop");
    const metadata = (await result.providerMetadata)?.[PROVIDER_NAME];
    expect(metadata).toMatchObject({
      sessionId: expect.any(String),
      lastAssistantUuid: expect.any(String),
      costUsd: expect.any(Number),
      durationMs: expect.any(Number),
      permissionDenials: [],
    });
    const usage = await result.usage;
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  test("stream part の並び（text-partial）", async () => {
    const { model } = await setup("text-partial");
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });
    const parts = await collectParts(stream);
    expect(parts.map((p) => p.type)).toEqual([
      "stream-start",
      "response-metadata",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  test("thinking は reasoning パーツになる", async () => {
    const { model } = await setup("thinking");
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });
    const types = (await collectParts(stream)).map((p) => p.type);
    expect(types).toContain("reasoning-start");
    expect(types).toContain("reasoning-end");
    expect(types.indexOf("reasoning-start")).toBeLessThan(
      types.indexOf("text-start"),
    );
  });

  test("Read ツールは dynamic-tool パーツになり、結果が入る（tool-read）", async () => {
    const { model } = await setup("tool-read");
    const message = await lastUIMessage(streamText({ model, prompt }));
    const tool = message?.parts.find((p) => p.type === "dynamic-tool");
    expect(tool).toMatchObject({
      type: "dynamic-tool",
      toolName: "Read",
      state: "output-available",
      providerExecuted: true,
      input: { file_path: "/tmp/cc-manabu-fixture/hello.txt" },
    });
    expect(
      tool?.type === "dynamic-tool" && tool.state === "output-available"
        ? String(tool.output)
        : "",
    ).toContain("Hello from cc-manabu!");
  });

  test("ツールのエラーは output-error になる（tool-error）", async () => {
    const { model } = await setup("tool-error");
    const message = await lastUIMessage(streamText({ model, prompt }));
    const tool = message?.parts.find((p) => p.type === "dynamic-tool");
    expect(tool).toMatchObject({
      type: "dynamic-tool",
      toolName: "Read",
      state: "output-error",
    });
  });

  test("承認で拒否したツールは output-error になり、permissionDenials に残る", async () => {
    const { model } = await setup("tool-permission-deny");
    const result = streamText({ model, prompt });
    const message = await lastUIMessage(result);
    const tool = message?.parts.find((p) => p.type === "dynamic-tool");
    expect(tool).toMatchObject({
      toolName: "Bash",
      state: "output-error",
      errorText: expect.stringContaining("拒否"),
    });
    expect(
      (await result.providerMetadata)?.[PROVIDER_NAME]?.permissionDenials,
    ).toEqual([{ toolName: "Bash", toolUseId: expect.any(String) }]);
  });

  test("resume したターンでも同じ sessionId が返る", async () => {
    const turn1 = await setup("resume-turn1");
    const turn2 = await setup("resume");
    const r1 = streamText({ model: turn1.model, prompt });
    const r2 = streamText({
      model: turn2.model,
      prompt,
      providerOptions: { [PROVIDER_NAME]: { sessionId: "dummy" } },
    });
    const s1 = (await r1.providerMetadata)?.[PROVIDER_NAME]?.sessionId;
    const s2 = (await r2.providerMetadata)?.[PROVIDER_NAME]?.sessionId;
    expect(s1).toBeString();
    expect(s2).toBe(s1);
    expect(await r2.text).toBe("りんご");
    expect(turn2.calls[0]?.options?.resume).toBe("dummy");
  });

  test("中断すると以降のメッセージを流さず、エラーにもしない（abort）", async () => {
    const { model } = await setup("abort");
    const controller = new AbortController();
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      abortSignal: controller.signal,
    });
    const parts: LanguageModelV4StreamPart[] = [];
    for await (const part of stream) {
      parts.push(part);
      if (part.type === "text-delta") {
        controller.abort();
      }
    }
    const types = parts.map((p) => p.type);
    expect(types.filter((t) => t === "text-delta")).toHaveLength(1);
    expect(types).not.toContain("error");
    // 開いていたテキストブロックは閉じる
    expect(types.at(-1)).toBe("text-end");
  });

  test("includeRawChunks なら SDKMessage を raw パーツで流す", async () => {
    const { model } = await setup("text-partial");
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      includeRawChunks: true,
    });
    const raw = (await collectParts(stream)).filter((p) => p.type === "raw");
    expect(raw.length).toBeGreaterThan(0);
    expect(
      raw.some(
        (p) =>
          p.type === "raw" &&
          (p.rawValue as { type: string; subtype?: string }).subtype === "init",
      ),
    ).toBe(true);
  });

  test("query() が例外を投げたら error パーツを流す", async () => {
    const { query } = createFakeQuery([{ type: "__error__", message: "boom" }]);
    const model = createClaudeCode({ query })("haiku");
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });
    const parts = await collectParts(stream);
    expect(parts.at(-1)).toMatchObject({ type: "error" });
  });

  test("末尾がユーザー発話でなければ例外にする", async () => {
    const { model } = await setup("text-partial");
    expect(
      model.doStream({
        prompt: [
          { role: "assistant", content: [{ type: "text", text: "..." }] },
        ],
      }),
    ).rejects.toMatchObject({ name: "NoUserMessageError" });
  });
});
