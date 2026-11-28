import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import type { ChatMessageMetadata } from "../../src/chat/chat-service.ts";
import { router } from "../../src/router.ts";
import { createScriptedQuery } from "../e2e/scripted-query.ts";
import { createTestContext } from "../helpers/context.ts";

const drain = async (iterable: AsyncIterable<unknown>) => {
  for await (const _ of iterable) {
    // 読み切る
  }
};

describe("回答の出典（#258）", () => {
  test("本文の印に結び付いた出典を、番号を付けて回答と一緒に保存する", async () => {
    const ctx = createTestContext({ query: createScriptedQuery() });
    const client = createRouterClient(router, { context: ctx.context });
    const chat = await client.chats.create({});
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "出典を付けて答えて" }],
        },
      }),
    );
    const { messages } = await client.chats.get({ id: chat.id });
    const answer = messages.find((message) => message.role === "assistant");
    const citations = (answer?.metadata as ChatMessageMetadata | undefined)
      ?.citations;
    expect(
      citations?.sources.map((source) => [source.n, source.kind, source.url]),
    ).toEqual([
      [1, "web", "https://bun.sh/docs"],
      [2, "slack", "https://example.slack.com/archives/C1/p1700000000000100"],
      [3, "cosense", "https://scrapbox.io/team/認可_設計"],
    ]);
    expect(citations?.sources[1]?.excerpt).toBe("金曜にデプロイします");
  });

  test("出典の無い回答には付けない", async () => {
    const ctx = createTestContext({ query: createScriptedQuery() });
    const client = createRouterClient(router, { context: ctx.context });
    const chat = await client.chats.create({});
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "こんにちは" }],
        },
      }),
    );
    const { messages } = await client.chats.get({ id: chat.id });
    const answer = messages.find((message) => message.role === "assistant");
    expect(
      (answer?.metadata as ChatMessageMetadata | undefined)?.citations,
    ).toBeUndefined();
  });
});
