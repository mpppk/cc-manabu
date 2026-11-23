import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { Result } from "@praha/byethrow";
import { DatabaseError } from "../../src/db/chat-repository.ts";
import { router } from "../../src/router.ts";
import { createWikiContextBuilder } from "../../src/wiki/context.ts";
import { createTestContext } from "../helpers/context.ts";
import { createFakeQuery, loadFixture } from "../provider/fake-query.ts";

const setup = async () => {
  const fake = createFakeQuery(await loadFixture("text-partial"));
  const ctx = createTestContext({ query: fake.query });
  const client = createRouterClient(router, { context: ctx.context });
  return { ...ctx, ...fake, client };
};

const drain = async (iterable: AsyncIterable<unknown>) => {
  for await (const _ of iterable) {
    // 読み切る
  }
};

const send = async (
  client: Awaited<ReturnType<typeof setup>>["client"],
  chatId: string,
  text: string,
) =>
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

/** query() に渡った prompt を [参照資料?, 質問] のテキストにする。 */
const textsOf = async (prompt: unknown): Promise<string[]> => {
  if (typeof prompt === "string") {
    return [prompt];
  }
  const texts: string[] = [];
  for await (const message of prompt as AsyncIterable<{
    message: { content: { type: string; text?: string }[] };
  }>) {
    for (const block of message.message.content) {
      if (block.type === "text" && block.text !== undefined) {
        texts.push(block.text);
      }
    }
  }
  return texts;
};

describe("wiki の CRUD", () => {
  test("作成・一覧・取得・更新・削除。別名は空と重複を除く", async () => {
    const { client } = await setup();
    const project = await client.projects.create({ name: "p" });
    const page = await client.wiki.create({
      projectId: project.id,
      title: " 関係タプル ",
      aliases: ["tuple", " ", "tuple", "relation tuple"],
      body: "本文",
    });
    expect(page).toMatchObject({
      title: "関係タプル",
      aliases: ["tuple", "relation tuple"],
      projectId: project.id,
    });
    expect(
      (await client.wiki.list({ projectId: project.id })).map((p) => p.id),
    ).toEqual([page.id]);
    const updated = await client.wiki.update({
      id: page.id,
      title: "タプル",
      aliases: [],
      body: "新しい本文",
    });
    expect((await client.wiki.get({ id: page.id })).body).toBe("新しい本文");
    expect(updated.title).toBe("タプル");
    await client.wiki.delete({ id: page.id });
    expect(client.wiki.get({ id: page.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("存在しないプロジェクト・ページは NOT_FOUND、空のタイトルは BAD_REQUEST", async () => {
    const { client } = await setup();
    expect(client.wiki.list({ projectId: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      client.wiki.create({
        projectId: "missing",
        title: "t",
        aliases: [],
        body: "",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const project = await client.projects.create({ name: "p" });
    expect(
      client.wiki.create({
        projectId: project.id,
        title: " ",
        aliases: [],
        body: "",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      client.wiki.update({ id: "missing", title: "t", aliases: [], body: "" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("回答時の Wiki 参照", () => {
  const prepare = async () => {
    const s = await setup();
    const project = await s.client.projects.create({ name: "認可基盤" });
    const page = await s.client.wiki.create({
      projectId: project.id,
      title: "関係タプル",
      aliases: ["relation tuple"],
      body: "主体・関係・対象の 3 つ組。",
    });
    return { ...s, project, page };
  };

  test("プロジェクトのどのスレッドからでも、関連ページが質問とは別のブロックで届く", async () => {
    const { client, calls, project, page } = await prepare();
    const a = await client.chats.create({ projectId: project.id });
    const b = await client.chats.create({ projectId: project.id });
    await send(client, a.id, "関係タプルって何？");
    await send(client, b.id, "relation tuple の例を教えて");

    for (const call of calls) {
      const [reference, question] = await textsOf(call.prompt);
      expect(reference).toContain(`<wiki-page id="${page.id}"`);
      expect(reference).toContain("主体・関係・対象の 3 つ組。");
      expect(question).not.toContain("wiki-page");
    }

    // DB の発話には質問だけを保存し、応答の metadata に渡したページを残す
    const { messages } = await client.chats.get({ id: a.id });
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "関係タプルって何？" },
    ]);
    expect(messages[1]?.metadata).toMatchObject({
      wiki: {
        projectId: project.id,
        pages: [{ id: page.id, title: "関係タプル" }],
      },
    });
  });

  test("既存のセッションへの続きの送信でも、参照資料が届く", async () => {
    const { client, calls, project } = await prepare();
    const chat = await client.chats.create({ projectId: project.id });
    await send(client, chat.id, "こんにちは");
    await send(client, chat.id, "関係タプルについて");
    expect(calls[1]?.options?.resume).toBeString();
    expect((await textsOf(calls[1]?.prompt))[0]).toContain("<wiki-page");
  });

  test("関連ページが無い質問では、参照資料を送らない", async () => {
    const { client, calls, project } = await prepare();
    const chat = await client.chats.create({ projectId: project.id });
    await send(client, chat.id, "今日の天気は？");
    expect(calls[0]?.prompt).toBe("今日の天気は？");
    const { messages } = await client.chats.get({ id: chat.id });
    expect(
      (messages[1]?.metadata as { wiki?: unknown } | undefined)?.wiki,
    ).toBeUndefined();
  });

  test("未所属のスレッドや別のプロジェクトからは参照できない", async () => {
    const { client, calls } = await prepare();
    const other = await client.projects.create({ name: "別" });
    const loose = await client.chats.create({});
    const elsewhere = await client.chats.create({ projectId: other.id });
    await send(client, loose.id, "関係タプルって何？");
    await send(client, elsewhere.id, "関係タプルって何？");
    expect(calls.map((call) => call.prompt)).toEqual([
      "関係タプルって何？",
      "関係タプルって何？",
    ]);
  });

  test("再生成・編集でも参照資料を渡す", async () => {
    const { client, calls, project } = await prepare();
    const chat = await client.chats.create({ projectId: project.id });
    await send(client, chat.id, "関係タプルって何？");
    await drain(await client.chat.regenerate({ chatId: chat.id }));
    const { messages } = await client.chats.get({ id: chat.id });
    await drain(
      await client.chat.edit({
        chatId: chat.id,
        messageId: messages[0]?.id ?? "",
        text: "relation tuple を英語で",
      }),
    );
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect((await textsOf(call.prompt))[0]).toContain("<wiki-page");
    }
  });
});

describe("createWikiContextBuilder", () => {
  test("Wiki の読み込みに失敗したら undefined（通常どおり生成する）", () => {
    const errors: unknown[] = [];
    const failing = createWikiContextBuilder(
      { listPages: () => Result.fail(new DatabaseError()) },
      (error) => errors.push(error),
    );
    expect(failing("p", "関係タプル")).toBeUndefined();
    const throwing = createWikiContextBuilder(
      {
        listPages: () => {
          throw new Error("boom");
        },
      },
      (error) => errors.push(error),
    );
    expect(throwing("p", "関係タプル")).toBeUndefined();
    expect(errors).toHaveLength(2);
  });
});
