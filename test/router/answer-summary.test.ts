import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import type { QueryFunction } from "../../src/provider/index.ts";
import { router } from "../../src/router.ts";
import { createScriptedQuery } from "../e2e/scripted-query.ts";
import { createTestContext } from "../helpers/context.ts";

const setup = (
  options: {
    summarize?: (prompt: string) => Promise<string>;
    query?: QueryFunction;
  } = {},
) => {
  const prompts: string[] = [];
  const summarize =
    options.summarize ?? (async () => "関係タプルの意味を説明した。");
  const ctx = createTestContext({
    query: options.query ?? createScriptedQuery(),
    summarize: async (prompt) => {
      prompts.push(prompt);
      return summarize(prompt);
    },
  });
  const client = createRouterClient(router, { context: ctx.context });
  return { ...ctx, client, prompts };
};

const drain = async (iterable: AsyncIterable<unknown>) => {
  for await (const _ of iterable) {
    // 読み切る
  }
};

type Client = ReturnType<typeof setup>["client"];

const send = async (client: Client, chatId: string, text: string) =>
  drain(
    await client.chat.send({
      chatId,
      message: {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text }],
      },
    }),
  );

describe("回答の要約", () => {
  test("回答のあとに要約を作り、メッセージと chats.summaries から読める", async () => {
    const { client, summaryJobs, prompts } = setup();
    // タスクに属さない会話でも作る
    const chat = await client.chats.create({});
    await send(client, chat.id, "関係タプルとは");
    await Promise.all(summaryJobs);

    const { messages } = await client.chats.get({ id: chat.id });
    const answer = messages[1];
    expect(answer?.role).toBe("assistant");
    expect(answer?.metadata).toMatchObject({
      summary: "関係タプルの意味を説明した。",
    });
    expect(await client.chats.summaries({ id: chat.id })).toEqual({
      [answer?.id ?? ""]: "関係タプルの意味を説明した。",
    });
    // 要約には質問と回答を渡す
    expect(prompts[0]).toContain("<question>\n関係タプルとは\n</question>");
    expect(prompts[0]).toContain("了解: 関係タプルとは");
  });

  test("要約に失敗しても回答はそのまま残り、要約は付かない", async () => {
    const { client, summaryJobs } = setup({
      summarize: async () => {
        throw new Error("boom");
      },
    });
    const chat = await client.chats.create({});
    await send(client, chat.id, "関係タプルとは");
    await Promise.all(summaryJobs);

    const { messages } = await client.chats.get({ id: chat.id });
    expect(messages).toHaveLength(2);
    expect(messages[1]?.metadata).not.toHaveProperty("summary");
    expect(await client.chats.summaries({ id: chat.id })).toEqual({});
  });

  test("エラーになった回答は要約しない", async () => {
    const failing: QueryFunction = () => {
      throw new Error("boom");
    };
    const { client, summaryJobs, prompts } = setup({ query: failing });
    const chat = await client.chats.create({});
    await send(client, chat.id, "関係タプルとは");
    await Promise.all(summaryJobs);
    expect(summaryJobs).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });
});
