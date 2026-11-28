import { describe, expect, test } from "bun:test";
import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { createRouterClient } from "@orpc/server";
import type { QueryFunction } from "../../src/provider/types.ts";
import { router } from "../../src/router.ts";
import { createTestContext } from "../helpers/context.ts";
import { createFakeQuery, loadFixture } from "../provider/fake-query.ts";

const usageOf = (totalTokens: number) =>
  ({
    categories: [
      {
        id: "messages",
        name: "Messages",
        tokens: totalTokens,
        color: "",
        kind: "used",
      },
    ],
    totalTokens,
    maxTokens: 200000,
    rawMaxTokens: 200000,
    percentage: (totalTokens / 200000) * 100,
    gridRows: [],
    model: "claude-haiku",
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
  }) as SDKControlGetContextUsageResponse;

const drain = async (iterable: AsyncIterable<unknown>) => {
  for await (const _ of iterable) {
    // 読み切る
  }
};

const setup = async () => {
  const fake = createFakeQuery(await loadFixture("text-partial"));
  let tokens = 1000;
  const query: QueryFunction = (params) =>
    Object.assign(fake.query(params), {
      getContextUsage: async () => {
        tokens += 1000;
        return usageOf(tokens);
      },
    }) as unknown as ReturnType<QueryFunction>;
  const ctx = createTestContext({ query, contextUsage: true });
  const client = createRouterClient(router, { context: ctx.context });
  return { ...ctx, client };
};

const send = (
  client: Awaited<ReturnType<typeof setup>>["client"],
  chatId: string,
  text: string,
) =>
  client.chat
    .send({
      chatId,
      message: {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text }],
      },
    })
    .then(drain);

describe("chats.contextUsage（#245）", () => {
  test("まだ回答の無い会話は null", async () => {
    const { client } = await setup();
    const chat = await client.chats.create({ model: "haiku" });
    expect(await client.chats.contextUsage({ id: chat.id })).toBeNull();
  });

  test("回答のあとに取れた最新の値を会話ごとに残す", async () => {
    const { client } = await setup();
    const a = await client.chats.create({ model: "haiku" });
    const b = await client.chats.create({ model: "haiku" });
    await send(client, a.id, "1");
    expect(await client.chats.contextUsage({ id: a.id })).toMatchObject({
      totalTokens: 2000,
      maxTokens: 200000,
      percentage: 1,
    });
    await send(client, a.id, "2");
    expect((await client.chats.contextUsage({ id: a.id }))?.totalTokens).toBe(
      3000,
    );
    // 別の会話には残さない
    expect(await client.chats.contextUsage({ id: b.id })).toBeNull();
  });

  test("使用量を残しても、一覧の並び（更新日時）は変えない", async () => {
    const { client, chats } = await setup();
    const chat = await client.chats.create({ model: "haiku" });
    await send(client, chat.id, "1");
    const before = (await client.chats.list()).find((c) => c.id === chat.id);
    chats.setContextUsage(chat.id, {
      totalTokens: 1,
      maxTokens: 2,
      percentage: 50,
      model: "m",
      categories: [],
      capturedAt: new Date().toISOString(),
    });
    const after = (await client.chats.list()).find((c) => c.id === chat.id);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });
});
