import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import type { QueueRepository } from "../../src/db/queue-repository.ts";
import type { QueryFunction } from "../../src/provider/index.ts";
import { router } from "../../src/router.ts";
import { createScriptedQuery } from "../e2e/scripted-query.ts";
import { createTestContext } from "../helpers/context.ts";
import { waitFor } from "../helpers/wait-for.ts";

const setup = (
  options: { query?: QueryFunction; maxConcurrent?: number } = {},
) => {
  const ctx = createTestContext({
    query: options.query ?? createScriptedQuery(),
    ...(options.maxConcurrent === undefined
      ? {}
      : { maxConcurrent: options.maxConcurrent }),
  });
  const client = createRouterClient(router, { context: ctx.context });
  return { ...ctx, client };
};

type Client = ReturnType<typeof setup>["client"];

const message = (text: string, id: string = crypto.randomUUID()) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

const textsOf = async (client: Client, chatId: string) =>
  (await client.chats.get({ id: chatId })).messages.map((m) =>
    (m.parts as { type: string; text?: string }[])
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join(""),
  );

/** ゆっくり流れる生成を始め、生成中になるまで待つ。 */
const startSlow = async (client: Client, chatId: string) => {
  const stream = await client.chat.send({
    chatId,
    message: message("ゆっくり数えて"),
  });
  const reading = (async () => {
    for await (const _ of stream) {
      // 読み切る
    }
  })();
  await waitFor(
    async () =>
      (await client.chats.get({ id: chatId })).chat.status === "running",
  );
  // Promise をそのまま返すと await で完了まで待ってしまうので、包んで返す
  return { reading };
};

const idle = (client: Client, chatId: string) =>
  waitFor(async () => {
    const { chat, messages } = await client.chats.get({ id: chatId });
    const { items } = await client.queue.list({ chatId });
    return (
      chat.status !== "running" &&
      items.length === 0 &&
      messages.at(-1)?.role === "assistant"
    );
  }, 15_000);

describe("予約したメッセージ（#102）", () => {
  test("生成中に 2 件予約すると、割り込まずに回答のあと順に送る（会話を引き継ぐ）", async () => {
    const { client } = setup();
    const chat = await client.chats.create({});
    const { reading } = await startSlow(client, chat.id);
    await client.queue.add({ chatId: chat.id, message: message("予約1") });
    await client.queue.add({ chatId: chat.id, message: message("予約2") });
    expect(
      (await client.queue.list({ chatId: chat.id })).items.map((i) => i.status),
    ).toEqual(["pending", "pending"]);
    // 生成中は送らない
    expect(await textsOf(client, chat.id)).toEqual(["ゆっくり数えて"]);

    await reading;
    await idle(client, chat.id);
    const texts = await textsOf(client, chat.id);
    expect(texts.slice(2)).toEqual([
      "予約1",
      "了解: 予約1",
      "予約2",
      "了解: 予約2",
    ]);
  }, 20_000);

  test("生成中でなければ、予約はすぐ送る", async () => {
    const { client } = setup();
    const chat = await client.chats.create({});
    await client.queue.add({ chatId: chat.id, message: message("すぐ") });
    await idle(client, chat.id);
    expect(await textsOf(client, chat.id)).toEqual(["すぐ", "了解: すぐ"]);
  }, 20_000);

  test("承認待ちの間は送らない", async () => {
    const { client, approvals } = setup();
    const chat = await client.chats.create({});
    const stream = await client.chat.send({
      chatId: chat.id,
      message: message("承認して"),
    });
    const chunks: unknown[] = [];
    const reading = (async () => {
      for await (const chunk of stream) chunks.push(chunk);
    })();
    await waitFor(
      async () =>
        (await client.chats.get({ id: chat.id })).chat.status ===
        "awaiting_approval",
    );
    await client.queue.add({ chatId: chat.id, message: message("許可の次") });
    await Bun.sleep(100);
    expect(await textsOf(client, chat.id)).toEqual(["承認して"]);

    const pending = chunks.find(
      (c) => (c as { type?: string }).type === "data-approval",
    ) as { data: { approvalId: string } };
    await client.approvals.respond({
      chatId: chat.id,
      approvalId: pending.data.approvalId,
      behavior: "allow",
    });
    await reading;
    await idle(client, chat.id);
    expect((await textsOf(client, chat.id)).slice(-2)).toEqual([
      "許可の次",
      "了解: 許可の次",
    ]);
    expect(approvals).toBeDefined();
  }, 20_000);

  test("停止すると一時停止し、残りを編集・取り消しして再開できる", async () => {
    const { client } = setup();
    const chat = await client.chats.create({});
    const { reading } = await startSlow(client, chat.id);
    const a = await client.queue.add({
      chatId: chat.id,
      message: message("A"),
    });
    const b = await client.queue.add({
      chatId: chat.id,
      message: message("B"),
    });
    await client.chat.stop({ chatId: chat.id });
    await reading;
    await waitFor(
      async () => (await client.queue.list({ chatId: chat.id })).paused,
    );
    await Bun.sleep(50);
    expect(await textsOf(client, chat.id)).not.toContain("A");

    await client.queue.update({ id: a.id, text: "A を書き換え" });
    await client.queue.remove({ id: b.id });
    await client.queue.resume({ chatId: chat.id });
    await idle(client, chat.id);
    const texts = await textsOf(client, chat.id);
    expect(texts.slice(-2)).toEqual(["A を書き換え", "了解: A を書き換え"]);
    expect(texts).not.toContain("B");
    expect((await client.queue.list({ chatId: chat.id })).paused).toBe(false);
  }, 20_000);

  test("エラーで終わると一時停止する", async () => {
    let fail = false;
    const scripted = createScriptedQuery();
    const { client } = setup({
      query: (params) => {
        if (fail) throw new Error("boom");
        return scripted(params);
      },
    });
    const chat = await client.chats.create({});
    fail = true;
    const stream = await client.chat.send({
      chatId: chat.id,
      message: message("失敗する"),
    });
    await client.queue.add({ chatId: chat.id, message: message("あと") });
    for await (const _ of stream) {
      // 読み切る
    }
    await waitFor(
      async () => (await client.queue.list({ chatId: chat.id })).paused,
    );
    fail = false;
    await client.queue.resume({ chatId: chat.id });
    await idle(client, chat.id);
    expect((await textsOf(client, chat.id)).slice(-2)).toEqual([
      "あと",
      "了解: あと",
    ]);
  }, 20_000);

  test("同時生成の上限に当たったら待ち、空きが出たら送る", async () => {
    const { client } = setup({ maxConcurrent: 1 });
    const a = await client.chats.create({});
    const b = await client.chats.create({});
    const { reading } = await startSlow(client, a.id);
    await client.queue.add({ chatId: b.id, message: message("B の予約") });
    await Bun.sleep(50);
    expect(
      (await client.queue.list({ chatId: b.id })).items.map((i) => i.status),
    ).toEqual(["pending"]);
    await reading;
    await idle(client, b.id);
    expect(await textsOf(client, b.id)).toEqual(["B の予約", "了解: B の予約"]);
  }, 20_000);

  test("サーバ再起動では、送信済みの予約は消し、分からないものは保留にして一時停止する", async () => {
    const { client, queue } = setup();
    const chat = await client.chats.create({});
    for await (const _ of await client.chat.send({
      chatId: chat.id,
      message: message("送った", "sent-id"),
    })) {
      // 読み切る
    }
    const q = queue as QueueRepository;
    q.add({ id: "sent-id", chatId: chat.id, parts: [] });
    q.setStatus("sent-id", "sending");
    q.add({ id: "unknown-id", chatId: chat.id, parts: message("不明").parts });
    q.setStatus("unknown-id", "sending");
    q.add({ id: "pending-id", chatId: chat.id, parts: message("待ち").parts });
    q.recover();

    const after = await client.queue.list({ chatId: chat.id });
    expect(after.paused).toBe(true);
    expect(after.items.map((i) => [i.id, i.status])).toEqual([
      ["unknown-id", "held"],
      ["pending-id", "pending"],
    ]);

    // 保留を確かめて送信待ちに戻し、再開すると順に送る（重複しない）
    await client.queue.release({ id: "unknown-id" });
    await client.queue.resume({ chatId: chat.id });
    await idle(client, chat.id);
    const texts = await textsOf(client, chat.id);
    expect(texts.filter((t) => t === "送った")).toHaveLength(1);
    expect(texts.slice(-4)).toEqual([
      "不明",
      "了解: 不明",
      "待ち",
      "了解: 待ち",
    ]);
  });
});
