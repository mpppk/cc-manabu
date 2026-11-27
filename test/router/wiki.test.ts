import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { Result } from "@praha/byethrow";
import { DatabaseError } from "../../src/db/chat-repository.ts";
import type { TaskRow } from "../../src/db/schema.ts";
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
    const task = await client.tasks.create({ name: "p" });
    const page = await client.wiki.create({
      taskId: task.id,
      title: " 関係タプル ",
      aliases: ["tuple", " ", "tuple", "relation tuple"],
      body: "本文",
    });
    expect(page).toMatchObject({
      title: "関係タプル",
      aliases: ["tuple", "relation tuple"],
      wikiId: task.wikiId,
    });
    expect(
      (await client.wiki.list({ taskId: task.id })).map((p) => p.id),
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

  test("存在しないタスク・ページは NOT_FOUND、空のタイトルは BAD_REQUEST", async () => {
    const { client } = await setup();
    expect(client.wiki.list({ taskId: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      client.wiki.create({
        taskId: "missing",
        title: "t",
        aliases: [],
        body: "",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const task = await client.tasks.create({ name: "p" });
    expect(
      client.wiki.create({
        taskId: task.id,
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
    const task = await s.client.tasks.create({ name: "認可基盤" });
    const page = await s.client.wiki.create({
      taskId: task.id,
      title: "関係タプル",
      aliases: ["relation tuple"],
      body: "主体・関係・対象の 3 つ組。",
    });
    return { ...s, task, page };
  };

  test("タスクのどのスレッドからでも、関連ページが質問とは別のブロックで届く", async () => {
    const { client, calls, task, page } = await prepare();
    const a = await client.chats.create({ taskId: task.id });
    const b = await client.chats.create({ taskId: task.id });
    await send(client, a.id, "関係タプルって何？");
    await send(client, b.id, "relation tuple の例を教えて");

    for (const call of calls) {
      const [reference, question] = await textsOf(call.prompt);
      expect(reference).toContain(`<wiki-page id="${page.id}"`);
      expect(reference).toContain("主体・関係・対象の 3 つ組。");
      expect(question).not.toContain("wiki-page");
    }

    // DB の発話には質問だけを保存し、回答の metadata に渡したページを残す
    const { messages } = await client.chats.get({ id: a.id });
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "関係タプルって何？" },
    ]);
    expect(messages[1]?.metadata).toMatchObject({
      wiki: {
        taskId: task.id,
        pages: [{ id: page.id, title: "関係タプル" }],
      },
    });
  });

  test("既存のセッションへの続きの送信でも、参照資料が届く", async () => {
    const { client, calls, task } = await prepare();
    const chat = await client.chats.create({ taskId: task.id });
    await send(client, chat.id, "こんにちは");
    await send(client, chat.id, "関係タプルについて");
    expect(calls[1]?.options?.resume).toBeString();
    expect((await textsOf(calls[1]?.prompt))[0]).toContain("<wiki-page");
  });

  test("関連ページが無い質問では、参照資料を送らない", async () => {
    const { client, calls, task } = await prepare();
    const chat = await client.chats.create({ taskId: task.id });
    await send(client, chat.id, "今日の天気は？");
    expect(calls[0]?.prompt).toBe("今日の天気は？");
    const { messages } = await client.chats.get({ id: chat.id });
    expect(
      (messages[1]?.metadata as { wiki?: unknown } | undefined)?.wiki,
    ).toBeUndefined();
  });

  test("未所属のスレッドや別のタスクからは参照できない", async () => {
    const { client, calls } = await prepare();
    const other = await client.tasks.create({ name: "別" });
    const loose = await client.chats.create({});
    const elsewhere = await client.chats.create({ taskId: other.id });
    await send(client, loose.id, "関係タプルって何？");
    await send(client, elsewhere.id, "関係タプルって何？");
    expect(calls.map((call) => call.prompt)).toEqual([
      "関係タプルって何？",
      "関係タプルって何？",
    ]);
  });

  test("再生成・編集でも参照資料を渡す", async () => {
    const { client, calls, task } = await prepare();
    const chat = await client.chats.create({ taskId: task.id });
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

describe("Wiki の個別ページからの質問", () => {
  const message = (text: string) => ({
    id: crypto.randomUUID(),
    role: "user" as const,
    parts: [{ type: "text", text }],
  });

  test("ページ名なしで質問でき、追加質問は会話と最新の本文を引き継ぐ", async () => {
    const { client, calls } = await setup();
    const task = await client.tasks.create({ name: "運用" });
    const page = await client.wiki.create({
      taskId: task.id,
      title: "認可",
      aliases: [],
      body: "委譲の旧ルール",
    });
    const target = { taskId: task.id, pageId: page.id };
    expect(await client.wiki.chat(target)).toBeNull();
    const { chatId } = await client.wiki.ask({
      ...target,
      message: message("要約して"),
    });
    await drain(await client.chat.reconnect({ chatId }));
    const [firstReference, firstQuestion] = await textsOf(calls[0]?.prompt);
    expect(firstReference).toContain(`<wiki-page id="${page.id}"`);
    expect(firstReference).toContain("委譲の旧ルール");
    expect(firstQuestion).toBe("要約して");

    await client.wiki.update({
      id: page.id,
      title: page.title,
      aliases: [],
      body: `${"別の説明。".repeat(500)}

## 委譲
新ルールでは管理者が承認する。`,
    });
    await send(client, chatId, "委譲って何？");
    const [nextReference, nextQuestion] = await textsOf(calls[1]?.prompt);
    expect(calls[1]?.options?.resume).toBeString();
    expect(nextReference).toContain("## 委譲\n新ルールでは管理者が承認する。");
    expect(nextReference).toContain("本文は抜粋です。");
    expect(nextReference).not.toContain("旧ルール");
    expect(nextQuestion).toBe("委譲って何？");
    const saved = await client.wiki.chat(target);
    expect(saved?.chat.id).toBe(chatId);
    expect(saved?.messages.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(saved?.messages[2]?.parts).toEqual([
      { type: "text", text: "委譲って何？" },
    ]);
    expect(saved?.messages[3]?.metadata).toMatchObject({
      wiki: { excerpted: true },
    });
  });

  test("共有 Wiki でも履歴を分け、範囲外や削除済みのページを送信できない", async () => {
    const { client, calls } = await setup();
    const a = await client.tasks.create({ name: "開発" });
    const b = await client.tasks.create({
      name: "運用",
      environmentId: a.environmentId ?? "",
    });
    const other = await client.tasks.create({ name: "別の Wiki" });
    const page = await client.wiki.create({
      taskId: a.id,
      title: "手順",
      aliases: [],
      body: "手順の本文",
    });
    const target = (taskId: string) => ({ taskId, pageId: page.id });
    const ask = (taskId: string, text: string) =>
      client.wiki.ask({ ...target(taskId), message: message(text) });

    await expect(ask(other.id, "要約して")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const first = await ask(a.id, "開発での質問");
    await drain(await client.chat.reconnect(first));
    expect(await client.wiki.chat(target(b.id))).toBeNull();
    const second = await ask(b.id, "運用での質問");
    await drain(await client.chat.reconnect(second));
    expect(first.chatId).not.toBe(second.chatId);
    await expect(
      client.chats.setTask({ id: first.chatId, taskId: b.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await client.wiki.delete({ id: page.id });
    for (const [taskId, chatId, question] of [
      [a.id, first.chatId, "開発での質問"],
      [b.id, second.chatId, "運用での質問"],
    ] as const) {
      const history = await client.wiki.chat(target(taskId));
      expect(history?.chat.id).toBe(chatId);
      expect(history?.messages[0]?.parts).toEqual([
        { type: "text", text: question },
      ]);
      await expect(
        send(client, chatId, "もう一度要約して"),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: expect.stringContaining("参照できません"),
      });
      await expect(client.chat.regenerate({ chatId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await client.wiki.chat(target(taskId))).toEqual(history);
    }
    expect(calls).toHaveLength(2);
    expect(await client.chats.list()).toHaveLength(2);
  });
});

describe("Wiki の共有", () => {
  test("同じ環境に作ったタスクは、同じページを読み書きし、回答の参照資料にも使う", async () => {
    const { client } = await setup();
    const a = await client.tasks.create({ name: "認可基盤" });
    const page = await client.wiki.create({
      taskId: a.id,
      title: "関係タプル",
      aliases: [],
      body: "社内では三つ組チケットと呼ぶ。",
    });
    const b = await client.tasks.create({
      name: "監査ログ",
      environmentId: a.environmentId ?? "",
    });
    expect(b.wikiId).toBe(a.wikiId);
    expect((await client.wiki.list({ taskId: b.id })).map((p) => p.id)).toEqual(
      [page.id],
    );
    expect(await client.wikis.list()).toEqual([
      { id: a.wikiId ?? "", name: "認可基盤", taskCount: 2 },
    ]);
    await client.wikis.rename({ id: a.wikiId ?? "", name: "共通用語集" });
    expect((await client.wikis.list())[0]?.name).toBe("共通用語集");

    // 新しい環境（と Wiki）を作ったタスクには見えない
    const c = await client.tasks.create({ name: "別件" });
    expect(c.wikiId).not.toBe(a.wikiId);
    expect(await client.wiki.list({ taskId: c.id })).toEqual([]);

    // 無い環境は指定できない
    await expect(
      client.tasks.create({ name: "x", environmentId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("createWikiContextBuilder", () => {
  test("Wiki の読み込みに失敗したら undefined（通常どおり生成する）", () => {
    const errors: unknown[] = [];
    const task = { id: "p", wikiId: "p" } as unknown as TaskRow;
    const failing = createWikiContextBuilder(
      { listPages: () => Result.fail(new DatabaseError()) },
      { getTask: () => Result.succeed(task) },
      (error) => errors.push(error),
    );
    expect(failing("p", "関係タプル")).toBeUndefined();
    const throwing = createWikiContextBuilder(
      {
        listPages: () => {
          throw new Error("boom");
        },
      },
      { getTask: () => Result.succeed(task) },
      (error) => errors.push(error),
    );
    expect(throwing("p", "関係タプル")).toBeUndefined();
    expect(errors).toHaveLength(2);
  });
});

describe("タスクのスレッドで、Claude が Wiki を読み書きする", () => {
  const message = (
    text: string,
    quote?: { text: string; sourcePage: { id: string; title: string } },
  ) => ({
    id: crypto.randomUUID(),
    role: "user" as const,
    parts: [
      ...(quote === undefined ? [] : [{ type: "data-quote", data: quote }]),
      { type: "text", text },
    ],
  });

  test("タスクの会話には wiki と task の MCP サーバを渡し、タスクに属さない会話には渡さない", async () => {
    const { client, calls } = await setup();
    const task = await client.tasks.create({ name: "運用" });
    const page = await client.wiki.create({
      taskId: task.id,
      title: "認可",
      aliases: [],
      body: "認可の本文",
    });
    const { chatId } = await client.wiki.ask({
      taskId: task.id,
      pageId: page.id,
      message: message("このページに例を追記して"),
    });
    await drain(await client.chat.reconnect({ chatId }));
    expect(Object.keys(calls[0]?.options?.mcpServers ?? {})).toEqual([
      "wiki",
      "task",
    ]);
    // 追加の質問（resume）でも渡す
    await send(client, chatId, "もう少し短く");
    expect(Object.keys(calls[1]?.options?.mcpServers ?? {})).toEqual([
      "wiki",
      "task",
    ]);

    // Wiki ページにひも付かない、ふつうのスレッドでも渡す
    const chat = await client.chats.create({ taskId: task.id });
    await send(client, chat.id, "認可のページを更新して");
    expect(Object.keys(calls[2]?.options?.mcpServers ?? {})).toEqual([
      "wiki",
      "task",
    ]);

    // タスクに属さないスレッドには Wiki が無いので渡さない
    const loose = await client.chats.create({});
    await send(client, loose.id, "ふつうの質問");
    expect(calls[3]?.options?.mcpServers).toBeUndefined();
  });

  test("Wiki を使わない環境のタスクには wiki の MCP サーバを渡さず、Wiki を読み書きできない（#232）", async () => {
    const { client, calls } = await setup();
    const environment = await client.environments.create({
      name: "Wiki なし",
      directories: [process.cwd()],
      wikiId: null,
    });
    expect(environment).toMatchObject({ wikiId: null, wikiName: null });
    expect(await client.wikis.list()).toEqual([]);
    const task = await client.tasks.create({
      name: "調査",
      environmentId: environment.id,
    });
    expect(task.wikiId).toBeNull();

    const chat = await client.chats.create({ taskId: task.id });
    await send(client, chat.id, "調べて");
    expect(Object.keys(calls[0]?.options?.mcpServers ?? {})).toEqual(["task"]);

    expect(await client.wiki.list({ taskId: task.id })).toEqual([]);
    await expect(
      client.wiki.create({
        taskId: task.id,
        title: "用語",
        aliases: [],
        body: "",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.wiki.undoState({ taskId: task.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // あとから新しい Wiki を作って使うと、ふつうに読み書きできる
    const updated = await client.environments.update({
      id: environment.id,
      newWiki: true,
    });
    expect(updated).toMatchObject({ wikiName: "Wiki なし" });
    expect(updated.wikiId).not.toBeNull();
    await client.wiki.create({
      taskId: task.id,
      title: "用語",
      aliases: [],
      body: "",
    });
    expect(
      (await client.wiki.list({ taskId: task.id })).map((p) => p.title),
    ).toEqual(["用語"]);
    await send(client, chat.id, "もう一度");
    expect(Object.keys(calls[1]?.options?.mcpServers ?? {})).toEqual([
      "wiki",
      "task",
    ]);
  });

  test("本文から選んだ引用を質問に添えて渡し、発話に残す", async () => {
    const { client, calls } = await setup();
    const task = await client.tasks.create({ name: "運用" });
    const page = await client.wiki.create({
      taskId: task.id,
      title: "認可",
      aliases: [],
      body: "委譲では管理者が承認する。",
    });
    const quote = {
      text: "管理者が承認する",
      sourcePage: { id: page.id, title: page.title },
    };
    const { chatId } = await client.wiki.ask({
      taskId: task.id,
      pageId: page.id,
      message: message("誰が管理者？", quote),
    });
    await drain(await client.chat.reconnect({ chatId }));
    // 引用は質問の前に、質問と区別して渡す
    const [reference, prompt] = await textsOf(calls[0]?.prompt);
    expect(reference).toContain(`<wiki-page id="${page.id}"`);
    expect(prompt).toContain(`Wiki ページ「認可」（id: ${page.id}）`);
    expect(prompt).toContain("<quote>\n管理者が承認する\n</quote>");
    expect(prompt).toEndWith("誰が管理者？");
    const saved = await client.wiki.chat({ taskId: task.id, pageId: page.id });
    expect(saved?.messages[0]?.parts[0]).toEqual({
      type: "data-quote",
      data: quote,
    });
  });

  test("引用元の無い引用は受け付けない", async () => {
    const { client } = await setup();
    const task = await client.tasks.create({ name: "運用" });
    const page = await client.wiki.create({
      taskId: task.id,
      title: "認可",
      aliases: [],
      body: "本文",
    });
    await expect(
      client.wiki.ask({
        taskId: task.id,
        pageId: page.id,
        message: {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            { type: "data-quote", data: { text: "本文" } },
            { type: "text", text: "質問" },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
