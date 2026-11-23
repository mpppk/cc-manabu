/**
 * Spike #15: AI SDK v7 / LanguageModelV4 の挙動を確かめる。
 * Provider と ChatRunner の設計の前提をテストとして残す。
 */
import { describe, expect, test } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  createUIMessageStream,
  readUIMessageStream,
  streamText,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const providerExecutedToolStream: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "response-metadata", id: "msg_1", modelId: "claude-haiku-5-5" },
  { type: "text-start", id: "t0" },
  { type: "text-delta", id: "t0", delta: "読みます" },
  { type: "text-end", id: "t0" },
  {
    type: "tool-call",
    toolCallId: "toolu_1",
    toolName: "Read",
    input: JSON.stringify({ file_path: "/tmp/hello.txt" }),
    providerExecuted: true,
    dynamic: true,
  },
  {
    type: "tool-result",
    toolCallId: "toolu_1",
    toolName: "Read",
    result: "Hello",
    dynamic: true,
  },
  { type: "reasoning-start", id: "r0" },
  { type: "reasoning-delta", id: "r0", delta: "考え中" },
  { type: "reasoning-end", id: "r0" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "Hello でした" },
  { type: "text-end", id: "t1" },
  {
    type: "finish",
    usage,
    finishReason: { unified: "stop", raw: "end_turn" },
    providerMetadata: {
      "claude-code": { sessionId: "session-1", costUsd: 0.001 },
    },
  },
];

const createModel = (chunks: LanguageModelV4StreamPart[]) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks }),
    }),
  });

const collectChunks = async (
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessageChunk[]> => {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
};

/** ReadableStream.from は DOM の型定義にないため自前で変換する（ChatTransport でも使う）。 */
const toReadableStream = <T>(iterable: AsyncIterable<T>): ReadableStream<T> => {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    pull: async (controller) => {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel: async (reason) => {
      await iterator.return?.(reason);
    },
  });
};

const lastMessage = async (
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessage | undefined> => {
  let message: UIMessage | undefined;
  for await (const m of readUIMessageStream({ stream })) {
    message = m;
  }
  return message;
};

describe("providerExecuted なツール", () => {
  test("tools を渡さなくても streamText が受け付け、1 ステップで終わる", async () => {
    const result = streamText({
      model: createModel(providerExecutedToolStream),
      prompt: "hello.txt を読んで",
    });
    expect(await result.text).toBe("読みますHello でした");
    expect((await result.steps).length).toBe(1);
    const toolResults = await result.toolResults;
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      toolName: "Read",
      dynamic: true,
      output: "Hello",
    });
  });

  test("UIMessage では dynamic-tool パーツになり、テキストや reasoning と順序が保たれる", async () => {
    const result = streamText({
      model: createModel(providerExecutedToolStream),
      prompt: "hello.txt を読んで",
    });
    const message = await lastMessage(result.toUIMessageStream());
    const parts = message?.parts.filter((p) => p.type !== "step-start");
    expect(parts?.map((p) => p.type)).toEqual([
      "text",
      "dynamic-tool",
      "reasoning",
      "text",
    ]);
    expect(parts?.[1]).toMatchObject({
      type: "dynamic-tool",
      toolName: "Read",
      toolCallId: "toolu_1",
      state: "output-available",
      input: { file_path: "/tmp/hello.txt" },
      output: "Hello",
      providerExecuted: true,
    });
  });
});

describe("providerOptions と providerMetadata", () => {
  test("providerOptions はそのまま doStream に届く", async () => {
    const model = createModel(providerExecutedToolStream);
    const result = streamText({
      model,
      prompt: "hi",
      providerOptions: { "claude-code": { sessionId: "session-1" } },
    });
    await result.consumeStream();
    expect(model.doStreamCalls[0]?.providerOptions).toEqual({
      "claude-code": { sessionId: "session-1" },
    });
  });

  test("finish-step の providerMetadata と totalUsage は messageMetadata で UIMessage に載せられる", async () => {
    const result = streamText({
      model: createModel(providerExecutedToolStream),
      prompt: "hi",
    });
    const message = await lastMessage(
      result.toUIMessageStream({
        // stream 全体の finish パートには providerMetadata がない。finish-step から取る。
        messageMetadata: ({ part }) => {
          if (part.type === "finish-step") {
            return { claudeCode: part.providerMetadata?.["claude-code"] };
          }
          if (part.type === "finish") {
            return { totalTokens: part.totalUsage.totalTokens };
          }
          return undefined;
        },
      }),
    );
    expect(message?.metadata).toEqual({
      claudeCode: { sessionId: "session-1", costUsd: 0.001 },
      totalTokens: 15,
    });
  });
});

describe("createUIMessageStream", () => {
  test("streamText の出力に独自の data パーツ（承認要求など）を差し込める", async () => {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({
          type: "data-approval",
          id: "approval-1",
          data: { toolName: "Bash", input: { command: "touch a" } },
        });
        const result = streamText({
          model: createModel(providerExecutedToolStream),
          prompt: "hi",
        });
        writer.merge(result.toUIMessageStream());
      },
    });
    const chunks = await collectChunks(stream);
    expect(chunks.map((c) => c.type)).toContain("data-approval");
    expect(chunks.map((c) => c.type)).toContain("tool-output-available");
  });
});

describe("oRPC の eventIterator で UIMessageChunk を流す", () => {
  test("HTTP 越しに async iterator として受け取り、ReadableStream に戻して読める", async () => {
    const { os, eventIterator } = await import("@orpc/server");
    const { RPCHandler } = await import("@orpc/server/fetch");
    const { createORPCClient } = await import("@orpc/client");
    const { RPCLink } = await import("@orpc/client/fetch");
    const { z } = await import("zod");

    const router = {
      chat: {
        send: os
          .input(z.object({ prompt: z.string() }))
          .output(eventIterator(z.custom<UIMessageChunk>()))
          .handler(async function* ({ input }) {
            const result = streamText({
              model: createModel(providerExecutedToolStream),
              prompt: input.prompt,
            });
            yield* result.toUIMessageStream();
          }),
      },
    };

    const handler = new RPCHandler(router);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const { matched, response } = await handler.handle(request, {
          prefix: "/orpc",
        });
        return matched ? response : new Response("Not found", { status: 404 });
      },
    });

    try {
      const client: {
        chat: {
          send: (input: {
            prompt: string;
          }) => Promise<AsyncIterable<UIMessageChunk>>;
        };
      } = createORPCClient(
        new RPCLink({ url: `http://127.0.0.1:${server.port}/orpc` }),
      );
      const iterator = await client.chat.send({ prompt: "hi" });
      // ChatTransport.sendMessages は ReadableStream<UIMessageChunk> を返す必要がある
      const stream = toReadableStream(iterator);
      const message = await lastMessage(stream);
      expect(message?.parts.map((p) => p.type)).toContain("dynamic-tool");
    } finally {
      server.stop(true);
    }
  });
});
