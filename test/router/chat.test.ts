import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createRouterClient } from "@orpc/server";
import { readUIMessageStream, type UIMessageChunk } from "ai";
import { type ChatChunk, router } from "../../src/router.ts";
import { createTestContext } from "../helpers/context.ts";
import { waitFor } from "../helpers/wait-for.ts";
import { createFakeQuery, loadFixture } from "../provider/fake-query.ts";

const userMessage = (text: string, id: string = crypto.randomUUID()) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

const collect = async (iterable: AsyncIterable<UIMessageChunk>) => {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
};

const toStream = (chunks: UIMessageChunk[]) =>
  new ReadableStream<UIMessageChunk>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const setup = async (fixture: string) => {
  const lines = await loadFixture(fixture);
  const fake = createFakeQuery(lines);
  const ctx = createTestContext({ query: fake.query });
  const client = createRouterClient(router, { context: ctx.context });
  const chat = await client.chats.create({ model: "haiku" });
  return { ...ctx, ...fake, client, chat, lines };
};

const sessionIdOf = (lines: Awaited<ReturnType<typeof loadFixture>>) =>
  (
    lines.find((l) => l.type === "result") as Extract<
      SDKMessage,
      { type: "result" }
    >
  ).session_id;

describe("chat.send", () => {
  test("応答を流し、ユーザー発話と応答を保存し、セッション ID を記録する", async () => {
    const { client, chat, calls, chats, lines } = await setup("text-partial");
    const chunks = await collect(
      await client.chat.send({
        chatId: chat.id,
        message: userMessage("こんにちは", "u1"),
      }),
    );
    let message: unknown;
    for await (const m of readUIMessageStream({ stream: toStream(chunks) })) {
      message = m;
    }
    expect(message).toMatchObject({
      role: "assistant",
      parts: expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "こんにちは" }),
      ]),
      metadata: {
        model: "haiku",
        claudeCode: { sessionId: sessionIdOf(lines) },
      },
    });
    expect(calls[0]?.prompt).toBe("こんにちは");
    expect(calls[0]?.options?.resume).toBeUndefined();

    // 生成が終わって保存・状態の更新が済むまで待つ
    await waitFor(() => {
      const r = chats.getChat(chat.id);
      return (
        r.type === "Success" &&
        r.value.chat.status === "idle" &&
        r.value.messages.length === 2
      );
    });
    const saved = chats.getChat(chat.id);
    if (saved.type === "Failure") throw saved.error;
    expect(saved.value.chat).toMatchObject({
      sessionId: sessionIdOf(lines),
      status: "idle",
    });
    expect(saved.value.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(saved.value.messages[1]?.sdkUuid).toBeString();
  });

  test("2 回目の送信はセッションを resume する", async () => {
    const { client, chat, calls, lines } = await setup("text-partial");
    await collect(
      await client.chat.send({ chatId: chat.id, message: userMessage("1") }),
    );
    await collect(
      await client.chat.send({ chatId: chat.id, message: userMessage("2") }),
    );
    expect(calls[1]?.options?.resume).toBe(sessionIdOf(lines));
  });

  test("effort とモデルを会話に保存し、reasoning として渡す", async () => {
    const { client, chat, calls } = await setup("text-partial");
    await collect(
      await client.chat.send({
        chatId: chat.id,
        message: userMessage("hi"),
        model: "sonnet",
        effort: "high",
      }),
    );
    expect(calls[0]?.options).toMatchObject({
      model: "sonnet",
      effort: "high",
    });
    expect((await client.chats.get({ id: chat.id })).chat).toMatchObject({
      model: "sonnet",
      effort: "high",
    });
  });

  test("ツールの結果も保存される（tool-read）", async () => {
    const { client, chat, chats } = await setup("tool-read");
    await collect(
      await client.chat.send({
        chatId: chat.id,
        message: userMessage("読んで"),
      }),
    );
    // 生成が終わって保存・状態の更新が済むまで待つ
    await waitFor(() => {
      const r = chats.getChat(chat.id);
      return (
        r.type === "Success" &&
        r.value.chat.status === "idle" &&
        r.value.messages.length === 2
      );
    });
    const saved = chats.getChat(chat.id);
    if (saved.type === "Failure") throw saved.error;
    const parts = saved.value.messages[1]?.parts as { type: string }[];
    expect(parts.map((p) => p.type)).toContain("dynamic-tool");
  });

  test("エラーは日本語のメッセージで流し、会話の状態を error にする", async () => {
    const fake = createFakeQuery([
      {
        type: "__error__",
        message: "Claude Code native binary not found at /x/claude",
      },
    ]);
    const ctx = createTestContext({ query: fake.query });
    const client = createRouterClient(router, { context: ctx.context });
    const chat = await client.chats.create({});
    const chunks = await collect(
      await client.chat.send({ chatId: chat.id, message: userMessage("hi") }),
    );
    const error = chunks.find((c) => c.type === "error");
    expect(error).toMatchObject({
      errorText: expect.stringContaining("見つかりません"),
    });
    await waitFor(
      async () =>
        (await client.chats.get({ id: chat.id })).chat.status === "error",
    );
  });

  test("テキストの無い発話は BAD_REQUEST", async () => {
    const { client, chat } = await setup("text-partial");
    expect(
      client.chat.send({ chatId: chat.id, message: userMessage("  ") }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("存在しない会話は NOT_FOUND", async () => {
    const { client } = await setup("text-partial");
    expect(
      client.chat.send({ chatId: "missing", message: userMessage("hi") }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("chat.reconnect / chat.stop", () => {
  test("生成中でなければ reconnect はすぐ終わり、stop は false", async () => {
    const { client, chat } = await setup("text-partial");
    expect(
      await collect(await client.chat.reconnect({ chatId: chat.id })),
    ).toEqual([]);
    expect(await client.chat.stop({ chatId: chat.id })).toEqual({
      stopped: false,
    });
  });

  test("生成中に reconnect すると最初から流し直し、stop で止められる", async () => {
    const lines = await loadFixture("abort");
    const gate = Promise.withResolvers<void>();
    const fake = createFakeQuery(lines);
    // 2 通目以降を止めておき、生成中の状態を作る
    const query: typeof fake.query = (params) => {
      const inner = fake.query(params) as AsyncIterable<SDKMessage>;
      return (async function* () {
        let count = 0;
        for await (const m of inner) {
          if (count++ === 10) await gate.promise;
          yield m;
        }
      })();
    };
    const ctx = createTestContext({ query });
    const client = createRouterClient(router, { context: ctx.context });
    const chat = await client.chats.create({});
    const first = await client.chat.send({
      chatId: chat.id,
      message: userMessage("数えて"),
    });
    // 最初の接続は少しだけ読んで切る
    const firstChunks: UIMessageChunk[] = [];
    for await (const chunk of first) {
      firstChunks.push(chunk);
      if (firstChunks.length === 3) break;
    }
    const replay = await client.chat.reconnect({ chatId: chat.id });
    const replayed: UIMessageChunk[] = [];
    const reading = (async () => {
      for await (const chunk of replay) replayed.push(chunk);
    })();
    await waitFor(() => replayed.length >= 3);
    expect(replayed.slice(0, 3)).toEqual(firstChunks);
    expect(await client.chat.stop({ chatId: chat.id })).toEqual({
      stopped: true,
    });
    gate.resolve();
    await reading;
    await ctx.chatService.reconnect(chat.id)?.done;
    await waitFor(() => {
      const r = ctx.chats.getChat(chat.id);
      return r.type === "Success" && r.value.messages.length === 2;
    });
    const saved = ctx.chats.getChat(chat.id);
    if (saved.type === "Failure") throw saved.error;
    // 中断した応答も保存され、aborted が付く
    expect(saved.value.messages.at(-1)?.metadata).toMatchObject({
      aborted: true,
    });
  });
});

describe("approvals", () => {
  test("生成中に承認要求が流れ、approvals.respond で答えると続きが流れる", async () => {
    const lines = await loadFixture("text-partial");
    const fake = createFakeQuery(lines);
    const decisions: string[] = [];
    // 最初のメッセージの前に、Claude Code がツールの承認を求めたことにする
    const query: typeof fake.query = (params) => {
      const inner = fake.query(params) as AsyncIterable<SDKMessage>;
      return (async function* () {
        const result = await params.options?.canUseTool?.(
          "Bash",
          { command: "touch a.txt" },
          {
            signal: new AbortController().signal,
            suggestions: [],
            toolUseID: "toolu_x",
            displayName: "Bash",
            description: "Create a.txt",
          } as never,
        );
        decisions.push(result?.behavior ?? "none");
        yield* inner;
      })();
    };
    const ctx = createTestContext({ query });
    const client = createRouterClient(router, { context: ctx.context });
    const chat = await client.chats.create({});
    const stream = await client.chat.send({
      chatId: chat.id,
      message: userMessage("ファイルを作って"),
    });
    const chunks: ChatChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
      if (chunk.type === "data-approval" && chunk.data.status === "pending") {
        expect((await client.chats.get({ id: chat.id })).chat.status).toBe(
          "awaiting_approval",
        );
        // 別の会話の ID では答えられない
        expect(
          client.approvals.respond({
            chatId: "other",
            approvalId: chunk.data.approvalId,
            behavior: "allow",
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await client.approvals.respond({
          chatId: chat.id,
          approvalId: chunk.data.approvalId,
          behavior: "allow",
        });
      }
    }
    expect(decisions).toEqual(["allow"]);
    const approvalChunks = chunks.filter((c) => c.type === "data-approval");
    expect(
      approvalChunks.map((c) => c.type === "data-approval" && c.data.status),
    ).toEqual(["pending", "allowed"]);
    expect(chunks.some((c) => c.type === "text-delta")).toBe(true);
  });
});
