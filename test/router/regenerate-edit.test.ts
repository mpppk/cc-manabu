import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createRouterClient } from "@orpc/server";
import { router } from "../../src/router.ts";
import { createTestContext } from "../helpers/context.ts";
import { createFakeQuery, loadFixture } from "../provider/fake-query.ts";

const userMessage = (text: string, id: string = crypto.randomUUID()) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

const drain = async (iterable: AsyncIterable<unknown>) => {
  for await (const _ of iterable) {
    // 読み切る
  }
};

const setup = async () => {
  const lines = await loadFixture("text-partial");
  const fake = createFakeQuery(lines);
  const ctx = createTestContext({ query: fake.query });
  const client = createRouterClient(router, { context: ctx.context });
  const chat = await client.chats.create({});
  const sessionId = (
    lines.find((l) => l.type === "result") as Extract<
      SDKMessage,
      { type: "result" }
    >
  ).session_id;
  const lastAssistantUuid = (
    lines.findLast((l) => l.type === "assistant") as Extract<
      SDKMessage,
      { type: "assistant" }
    >
  ).uuid;
  /** 2 往復した会話を作る。 */
  const twoTurns = async () => {
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: userMessage("1", "u1"),
      }),
    );
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: userMessage("2", "u2"),
      }),
    );
  };
  const messages = async () =>
    (await client.chats.get({ id: chat.id })).messages.map((m) => [
      m.role === "user" ? m.id : "assistant",
      m.parts.find((p) => (p as { type: string }).type === "text"),
    ]);
  return {
    ...ctx,
    client,
    chat,
    calls: fake.calls,
    sessionId,
    lastAssistantUuid,
    twoTurns,
    messages,
  };
};

describe("chat.regenerate", () => {
  test("最後の回答を消し、直前のターンから fork して作り直す", async () => {
    const {
      client,
      chat,
      calls,
      twoTurns,
      sessionId,
      lastAssistantUuid,
      messages,
    } = await setup();
    await twoTurns();
    await drain(await client.chat.regenerate({ chatId: chat.id }));
    expect(calls).toHaveLength(3);
    expect(calls[2]?.prompt).toBe("2");
    expect(calls[2]?.options).toMatchObject({
      resume: sessionId,
      resumeSessionAt: lastAssistantUuid,
      forkSession: true,
    });
    expect((await messages()).map(([id]) => id)).toEqual([
      "u1",
      "assistant",
      "u2",
      "assistant",
    ]);
  });

  test("1 往復目の再生成は新しいセッションで送り直す", async () => {
    const { client, chat, calls } = await setup();
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: userMessage("1", "u1"),
      }),
    );
    await drain(await client.chat.regenerate({ chatId: chat.id }));
    expect(calls[1]?.options?.resume).toBeUndefined();
    expect(calls[1]?.options?.forkSession).toBeUndefined();
  });

  test("ユーザー発話が無ければ BAD_REQUEST", async () => {
    const { client, chat } = await setup();
    expect(client.chat.regenerate({ chatId: chat.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("chat.edit", () => {
  test("発話を書き換え、以降を消して、その直前から fork する", async () => {
    const {
      client,
      chat,
      calls,
      twoTurns,
      sessionId,
      lastAssistantUuid,
      messages,
    } = await setup();
    await twoTurns();
    await drain(
      await client.chat.edit({ chatId: chat.id, messageId: "u2", text: "二" }),
    );
    expect(calls[2]?.prompt).toBe("二");
    expect(calls[2]?.options).toMatchObject({
      resume: sessionId,
      resumeSessionAt: lastAssistantUuid,
      forkSession: true,
    });
    const after = await messages();
    expect(after.map(([id]) => id)).toEqual([
      "u1",
      "assistant",
      "u2",
      "assistant",
    ]);
    expect(after[2]?.[1]).toEqual({ type: "text", text: "二" });
  });

  test("最初の発話を編集すると、新しいセッションで最初からやり直す", async () => {
    const { client, chat, calls, twoTurns, messages } = await setup();
    await twoTurns();
    await drain(
      await client.chat.edit({ chatId: chat.id, messageId: "u1", text: "一" }),
    );
    expect(calls[2]?.options?.resume).toBeUndefined();
    expect((await messages()).map(([id]) => id)).toEqual(["u1", "assistant"]);
  });

  test("存在しない発話は NOT_FOUND", async () => {
    const { client, chat, twoTurns } = await setup();
    await twoTurns();
    expect(
      client.chat.edit({ chatId: chat.id, messageId: "nope", text: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("生成中は CONFLICT で、メッセージは消さない", async () => {
    const { client, chat, twoTurns, registry, messages } = await setup();
    await twoTurns();
    // 生成中の状態を作る
    registry.start(chat.id, () => new ReadableStream());
    expect(
      client.chat.edit({ chatId: chat.id, messageId: "u1", text: "x" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await messages()).toHaveLength(4);
  });
});
