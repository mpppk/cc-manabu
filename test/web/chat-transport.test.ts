import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { readUIMessageStream, type UIMessageChunk } from "ai";
import type { ChatUIMessage } from "../../src/chat/chat-service.ts";
import { router } from "../../src/router.ts";
import { OrpcChatTransport } from "../../src/web/lib/chat-transport.ts";
import { createTestContext } from "../helpers/context.ts";
import { waitFor } from "../helpers/wait-for.ts";
import { createFakeQuery, loadFixture } from "../provider/fake-query.ts";

const setup = async () => {
  const fake = createFakeQuery(await loadFixture("text-partial"));
  const ctx = createTestContext({ query: fake.query });
  const api = createRouterClient(router, { context: ctx.context });
  const chat = await api.chats.create({});
  return { ...ctx, api, chat, calls: fake.calls };
};

const lastMessage = async (stream: ReadableStream<UIMessageChunk>) => {
  let message: ChatUIMessage | undefined;
  for await (const m of readUIMessageStream<ChatUIMessage>({ stream })) {
    message = m;
  }
  return message;
};

const userMessage = (text: string): ChatUIMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
});

describe("OrpcChatTransport", () => {
  test("submit-message は chat.send を呼び、回答を流す", async () => {
    const { api, chat, calls } = await setup();
    const transport = new OrpcChatTransport(api, () => ({
      model: "sonnet",
      effort: "high",
    }));
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: chat.id,
      messageId: undefined,
      messages: [userMessage("こんにちは")],
      abortSignal: undefined,
    });
    const message = await lastMessage(stream);
    expect(message?.parts.some((p) => p.type === "text")).toBe(true);
    expect(calls[0]?.prompt).toBe("こんにちは");
    expect(calls[0]?.options).toMatchObject({
      model: "sonnet",
      effort: "high",
    });
  });

  test("regenerate-message は chat.regenerate を呼ぶ", async () => {
    const { api, chat, calls, chats } = await setup();
    const transport = new OrpcChatTransport(api);
    await lastMessage(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: chat.id,
        messageId: undefined,
        messages: [userMessage("1")],
        abortSignal: undefined,
      }),
    );
    await waitFor(() => {
      const r = chats.getChat(chat.id);
      return r.type === "Success" && r.value.chat.status === "idle";
    });
    await lastMessage(
      await transport.sendMessages({
        trigger: "regenerate-message",
        chatId: chat.id,
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      }),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toBe("1");
  });

  test("messageId 付きの submit-message は chat.edit を呼ぶ（発話の書き換え）", async () => {
    const { api, chat, calls, chats } = await setup();
    const transport = new OrpcChatTransport(api);
    const first = userMessage("1");
    await lastMessage(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: chat.id,
        messageId: undefined,
        messages: [first],
        abortSignal: undefined,
      }),
    );
    await waitFor(() => {
      const r = chats.getChat(chat.id);
      return r.type === "Success" && r.value.chat.status === "idle";
    });
    await lastMessage(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: chat.id,
        messageId: first.id,
        messages: [{ ...first, parts: [{ type: "text", text: "一" }] }],
        abortSignal: undefined,
      }),
    );
    expect(calls[1]?.prompt).toBe("一");
    const saved = chats.getChat(chat.id);
    if (saved.type === "Failure") throw saved.error;
    expect(saved.value.messages.map((m) => m.id)[0]).toBe(first.id);
    expect(saved.value.messages[0]?.parts).toEqual([
      { type: "text", text: "一" },
    ]);
  });

  test("生成中でなければ reconnectToStream は null", async () => {
    const { api, chat } = await setup();
    const transport = new OrpcChatTransport(api);
    expect(await transport.reconnectToStream({ chatId: chat.id })).toBeNull();
  });

  test("生成中なら reconnectToStream は先頭から流し直す", async () => {
    const { api, chat, registry } = await setup();
    // 生成中の状態を作る
    let push!: (c: UIMessageChunk) => void;
    let close!: () => void;
    registry.start(
      chat.id,
      () =>
        new ReadableStream<UIMessageChunk>({
          start: (controller) => {
            push = (c) => controller.enqueue(c);
            close = () => controller.close();
          },
        }),
    );
    push({ type: "start", messageId: "m1" });
    push({ type: "text-start", id: "t" });
    push({ type: "text-delta", id: "t", delta: "途中" });
    const transport = new OrpcChatTransport(api);
    const stream = await transport.reconnectToStream({ chatId: chat.id });
    expect(stream).not.toBeNull();
    push({ type: "text-delta", id: "t", delta: "まで" });
    push({ type: "text-end", id: "t" });
    push({ type: "finish" });
    close();
    const message = await lastMessage(stream as ReadableStream<UIMessageChunk>);
    expect(message?.parts).toEqual([
      { type: "text", text: "途中まで", state: "done" },
    ]);
  });
});
