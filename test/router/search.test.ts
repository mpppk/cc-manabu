import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { makeSnippet } from "../../src/db/search-repository.ts";
import { router } from "../../src/router.ts";
import { createScriptedQuery } from "../e2e/scripted-query.ts";
import { createTestContext } from "../helpers/context.ts";
import { waitFor } from "../helpers/wait-for.ts";

const setup = () => {
  const ctx = createTestContext({ query: createScriptedQuery() });
  return createRouterClient(router, { context: ctx.context });
};
type Client = ReturnType<typeof setup>;

const message = (text: string) => ({
  id: crypto.randomUUID(),
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const _ of stream) {
    // 読み切る
  }
};

const say = async (client: Client, chatId: string, text: string) =>
  drain(await client.chat.send({ chatId, message: message(text) }));

describe("会話の検索（#115）", () => {
  test("タイトルと、ユーザー発言・回答の本文を部分一致で探す（英字は大文字・小文字を区別しない）", async () => {
    const client = setup();
    const a = await client.chats.create({});
    await say(client, a.id, "TypeScript の型について");
    const b = await client.chats.create({});
    await say(client, b.id, "関係タプルとは何ですか");

    const typed = await client.search.query({ q: "typescript" });
    expect(typed.titles.map((t) => t.chatId)).toEqual([a.id]);
    // ユーザー発言と、それを繰り返す回答の両方
    expect(typed.messages.map((m) => [m.chatId, m.role]).sort()).toEqual([
      [a.id, "assistant"],
      [a.id, "user"],
    ]);
    const hit = typed.messages.find((m) => m.role === "user");
    expect(hit?.snippet).toEqual({
      before: "",
      match: "TypeScript",
      after: " の型について",
    });

    const japanese = await client.search.query({ q: "タプル" });
    expect(japanese.messages.every((m) => m.chatId === b.id)).toBe(true);
    expect(japanese.messages).toHaveLength(2);

    expect(await client.search.query({ q: "見つからない語" })).toEqual({
      titles: [],
      messages: [],
    });
  });

  test("% や _ も文字として扱う", async () => {
    const client = setup();
    const chat = await client.chats.create({});
    await say(client, chat.id, "進捗は 50% です");
    expect((await client.search.query({ q: "0%" })).messages).toHaveLength(2);
    expect((await client.search.query({ q: "_" })).messages).toHaveLength(0);
  });

  test("分岐で引き継いだ発言は重複して出さない", async () => {
    const client = setup();
    const root = await client.chats.create({});
    await say(client, root.id, "元の質問");
    const { messages } = await client.chats.get({ id: root.id });
    const branchId = crypto.randomUUID();
    await client.chat.branch({
      parentId: root.id,
      messageId: messages[1]?.id ?? "",
      branchId,
      message: message("分岐の質問"),
    });
    await drain(await client.chat.reconnect({ chatId: branchId }));
    await waitFor(
      async () =>
        (await client.chats.get({ id: branchId })).chat.status === "idle",
    );

    const original = await client.search.query({ q: "元の質問" });
    expect(original.messages.map((m) => m.chatId)).toEqual([root.id, root.id]);
    const branch = await client.search.query({ q: "分岐の質問" });
    expect(branch.messages.map((m) => m.chatId)).toEqual([branchId, branchId]);
    expect(branch.messages.every((m) => m.groupId === root.id)).toBe(true);
  });
});

describe("makeSnippet", () => {
  test("前後を切り出し、改行を空白にする", () => {
    const text = `${"あ".repeat(50)}\n検索語\n${"い".repeat(50)}`;
    const snippet = makeSnippet(text, "検索語");
    expect(snippet.match).toBe("検索語");
    expect(snippet.before).toBe(`…${"あ".repeat(39)} `);
    expect(snippet.after).toBe(` ${"い".repeat(39)}…`);
  });
});
