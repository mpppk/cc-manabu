import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import type { QueryFunction } from "../../src/provider/index.ts";
import { router } from "../../src/router.ts";
import { createScriptedQuery } from "../e2e/scripted-query.ts";
import { createTestContext } from "../helpers/context.ts";
import { waitFor } from "../helpers/wait-for.ts";

const relationTuple = JSON.stringify([
  {
    term: "関係タプル",
    aliases: ["relation tuple"],
    summary: "主体・関係・対象の 3 つ組。",
  },
]);

const setup = (
  options: {
    extract?: (prompt: string) => Promise<string>;
    query?: QueryFunction;
  } = {},
) => {
  const prompts: string[] = [];
  const extract =
    options.extract ??
    (async (prompt: string) => {
      prompts.push(prompt);
      return relationTuple;
    });
  const ctx = createTestContext({
    query: options.query ?? createScriptedQuery(),
    extract: async (prompt) => {
      prompts.push(prompt);
      return extract(prompt);
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

describe("回答からの用語ページの自動作成", () => {
  test("回答に出てくる重要な用語のページを作り、元の回答をたどれる", async () => {
    const { client, termJobs, prompts } = setup();
    const project = await client.projects.create({ name: "認可基盤" });
    const chat = await client.chats.create({ projectId: project.id });
    await send(client, chat.id, "関係タプルとは");
    await Promise.all(termJobs);

    const pages = await client.wiki.list({ projectId: project.id });
    const { messages } = await client.chats.get({ id: chat.id });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      title: "関係タプル",
      aliases: ["relation tuple"],
      body: "主体・関係・対象の 3 つ組。",
      origin: "auto",
      sourceChatId: chat.id,
      sourceMessageId: messages[1]?.id,
    });
    // 抽出には質問と回答を渡す
    expect(prompts[0]).toContain("<question>\n関係タプルとは\n</question>");
    expect(prompts[0]).toContain("了解: 関係タプルとは");
  });

  test("複数の回答を並行して処理しても、ページは 1 件だけ", async () => {
    const { client, termJobs } = setup();
    const project = await client.projects.create({ name: "p" });
    const chats = await Promise.all(
      [1, 2, 3].map(() => client.chats.create({ projectId: project.id })),
    );
    await Promise.all(
      chats.map((chat) => send(client, chat.id, "関係タプルとは")),
    );
    await Promise.all(termJobs);
    expect(termJobs).toHaveLength(3);
    expect(await client.wiki.list({ projectId: project.id })).toHaveLength(1);
  });

  test("編集したページは、同じ用語が出てきても書き換えない", async () => {
    const { client, termJobs } = setup();
    const project = await client.projects.create({ name: "p" });
    const chat = await client.chats.create({ projectId: project.id });
    await send(client, chat.id, "関係タプルとは");
    await Promise.all(termJobs);
    const [page] = await client.wiki.list({ projectId: project.id });
    await client.wiki.update({
      id: page?.id ?? "",
      title: "関係タプル",
      aliases: ["relation tuple"],
      body: "利用者が書いた説明",
    });

    await send(client, chat.id, "関係タプルの例");
    await Promise.all(termJobs);
    const pages = await client.wiki.list({ projectId: project.id });
    expect(pages).toHaveLength(1);
    expect(pages[0]?.body).toBe("利用者が書いた説明");
  });

  test("回答に出てこない語・既存の別名と同じ語は作らない", async () => {
    const { client, termJobs } = setup({
      extract: async () =>
        JSON.stringify([
          { term: "回答にない語", aliases: [], summary: "x" },
          { term: "relation tuple", aliases: [], summary: "x" },
        ]),
    });
    const project = await client.projects.create({ name: "p" });
    await client.wiki.create({
      projectId: project.id,
      title: "関係タプル",
      aliases: ["relation tuple"],
      body: "",
    });
    const chat = await client.chats.create({ projectId: project.id });
    await send(client, chat.id, "relation tuple とは");
    await Promise.all(termJobs);
    expect(await client.wiki.list({ projectId: project.id })).toHaveLength(1);
  });

  test("自動作成を止めたプロジェクトと未所属のスレッドでは、モデルを呼ばずページも作らない", async () => {
    const { client, termJobs, prompts } = setup();
    const project = await client.projects.create({ name: "p" });
    expect(
      (await client.projects.setAutoTerms({ id: project.id, enabled: false }))
        .autoTerms,
    ).toBe(false);
    const inProject = await client.chats.create({ projectId: project.id });
    const loose = await client.chats.create({});
    await send(client, inProject.id, "関係タプルとは");
    await send(client, loose.id, "関係タプルとは");
    await Promise.all(termJobs);
    expect(prompts).toEqual([]);
    expect(await client.wiki.list({ projectId: project.id })).toEqual([]);
  });

  test("途中で止めた回答・エラーになった回答では作らない", async () => {
    const failing: QueryFunction = () => {
      throw new Error("boom");
    };
    const scripted = createScriptedQuery();
    let fail = false;
    const { client, termJobs, prompts } = setup({
      query: (params) => (fail ? failing(params) : scripted(params)),
    });
    const project = await client.projects.create({ name: "p" });
    const chat = await client.chats.create({ projectId: project.id });

    // 「ゆっくり」はゆっくり流れるので、途中で止める
    const stream = await client.chat.send({
      chatId: chat.id,
      message: {
        id: "slow",
        role: "user",
        parts: [{ type: "text", text: "関係タプルをゆっくり" }],
      },
    });
    const reading = drain(stream);
    await waitFor(
      async () =>
        (await client.chats.get({ id: chat.id })).chat.status === "running",
    );
    await client.chat.stop({ chatId: chat.id });
    await reading;
    await waitFor(
      async () =>
        (await client.chats.get({ id: chat.id })).chat.status !== "running",
    );

    fail = true;
    await send(client, chat.id, "関係タプルとは");
    await Promise.all(termJobs);
    expect(prompts).toEqual([]);
    expect(await client.wiki.list({ projectId: project.id })).toEqual([]);
  });

  test("用語抽出が失敗しても回答は保存され、会話を続けられる", async () => {
    const { client, termJobs } = setup({
      extract: async () => {
        throw new Error("rate limited");
      },
    });
    const project = await client.projects.create({ name: "p" });
    const chat = await client.chats.create({ projectId: project.id });
    await send(client, chat.id, "関係タプルとは");
    await send(client, chat.id, "続き");
    await Promise.all(termJobs);
    const { messages } = await client.chats.get({ id: chat.id });
    expect(messages).toHaveLength(4);
    expect(await client.wiki.list({ projectId: project.id })).toEqual([]);
  });
});
