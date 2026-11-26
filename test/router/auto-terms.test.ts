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
    const task = await client.tasks.create({ name: "認可基盤" });
    const chat = await client.chats.create({ taskId: task.id });
    await send(client, chat.id, "関係タプルとは");
    await Promise.all(termJobs);

    const pages = await client.wiki.list({ taskId: task.id });
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
    const task = await client.tasks.create({ name: "p" });
    const chats = await Promise.all(
      [1, 2, 3].map(() => client.chats.create({ taskId: task.id })),
    );
    await Promise.all(
      chats.map((chat) => send(client, chat.id, "関係タプルとは")),
    );
    await Promise.all(termJobs);
    expect(termJobs).toHaveLength(3);
    expect(await client.wiki.list({ taskId: task.id })).toHaveLength(1);
  });

  test("編集したページは、同じ用語が出てきても書き換えない", async () => {
    const { client, termJobs } = setup();
    const task = await client.tasks.create({ name: "p" });
    const chat = await client.chats.create({ taskId: task.id });
    await send(client, chat.id, "関係タプルとは");
    await Promise.all(termJobs);
    const [page] = await client.wiki.list({ taskId: task.id });
    await client.wiki.update({
      id: page?.id ?? "",
      title: "関係タプル",
      aliases: ["relation tuple"],
      body: "利用者が書いた説明",
    });

    await send(client, chat.id, "関係タプルの例");
    await Promise.all(termJobs);
    const pages = await client.wiki.list({ taskId: task.id });
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
    const task = await client.tasks.create({ name: "p" });
    await client.wiki.create({
      taskId: task.id,
      title: "関係タプル",
      aliases: ["relation tuple"],
      body: "",
    });
    const chat = await client.chats.create({ taskId: task.id });
    await send(client, chat.id, "relation tuple とは");
    await Promise.all(termJobs);
    expect(await client.wiki.list({ taskId: task.id })).toHaveLength(1);
  });

  test("自動作成を止めたタスクと未所属のスレッドでは、モデルを呼ばずページも作らない", async () => {
    const { client, termJobs, prompts } = setup();
    const task = await client.tasks.create({ name: "p" });
    expect(
      (await client.tasks.setAutoTerms({ id: task.id, enabled: false }))
        .autoTerms,
    ).toBe(false);
    const inTask = await client.chats.create({ taskId: task.id });
    const loose = await client.chats.create({});
    await send(client, inTask.id, "関係タプルとは");
    await send(client, loose.id, "関係タプルとは");
    await Promise.all(termJobs);
    expect(prompts).toEqual([]);
    expect(await client.wiki.list({ taskId: task.id })).toEqual([]);
  });

  test("回答したタスクの環境の説明を用語抽出に渡す。Wiki を共有していても環境ごと（#160）", async () => {
    const { client, termJobs, prompts } = setup();
    const privacy = await client.environments.create({
      name: "個人情報",
      directories: [process.cwd()],
      description: "個人情報の取扱いを検討する",
    });
    const shared = await client.environments.create({
      name: "共有先",
      directories: [process.cwd()],
      wikiId: privacy.wikiId,
    });
    const privacyTask = await client.tasks.create({
      name: "検討",
      environmentId: privacy.id,
    });
    const sharedTask = await client.tasks.create({
      name: "共有",
      environmentId: shared.id,
    });

    const first = await client.chats.create({ taskId: privacyTask.id });
    await send(client, first.id, "仮名加工情報と Claude Artifact");
    await Promise.all(termJobs);
    expect(prompts.at(-1)).toContain(
      "<environment-description>\n個人情報の取扱いを検討する\n</environment-description>",
    );

    // 説明が空欄の環境では、説明を渡さない（従来どおり）
    const second = await client.chats.create({ taskId: sharedTask.id });
    await send(client, second.id, "関係タプルとは");
    await Promise.all(termJobs);
    expect(prompts.at(-1)).toContain("関係タプルとは");
    expect(prompts.at(-1)).not.toContain("<environment-description>");

    // 説明を変えると、次の抽出から使う
    await client.environments.update({
      id: shared.id,
      description: "認可の設計を検討する",
    });
    await send(client, second.id, "関係タプルの例");
    await Promise.all(termJobs);
    expect(prompts.at(-1)).toContain("認可の設計を検討する");
    expect(prompts.at(-1)).not.toContain("個人情報の取扱いを検討する");
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
    const task = await client.tasks.create({ name: "p" });
    const chat = await client.chats.create({ taskId: task.id });

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
    expect(await client.wiki.list({ taskId: task.id })).toEqual([]);
  });

  test("用語抽出が失敗しても回答は保存され、会話を続けられる", async () => {
    const { client, termJobs } = setup({
      extract: async () => {
        throw new Error("rate limited");
      },
    });
    const task = await client.tasks.create({ name: "p" });
    const chat = await client.chats.create({ taskId: task.id });
    await send(client, chat.id, "関係タプルとは");
    await send(client, chat.id, "続き");
    await Promise.all(termJobs);
    const { messages } = await client.chats.get({ id: chat.id });
    expect(messages).toHaveLength(4);
    expect(await client.wiki.list({ taskId: task.id })).toEqual([]);
  });
});
