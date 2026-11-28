import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { router } from "../../src/router.ts";
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

describe("tasks", () => {
  test("作成・一覧・名前変更・削除", async () => {
    const { client } = await setup();
    const a = await client.tasks.create({ name: " 認可基盤 " });
    const b = await client.tasks.create({ name: "家計簿" });
    expect(a.name).toBe("認可基盤");
    expect((await client.tasks.list()).map((p) => p.name)).toEqual([
      "認可基盤",
      "家計簿",
    ]);
    expect((await client.tasks.rename({ id: a.id, name: "認可" })).name).toBe(
      "認可",
    );
    await client.tasks.delete({ id: b.id });
    expect((await client.tasks.list()).map((p) => p.id)).toEqual([a.id]);
  });

  test("空の名前は BAD_REQUEST、存在しないタスクは NOT_FOUND", async () => {
    const { client } = await setup();
    expect(client.tasks.create({ name: "  " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(
      client.tasks.rename({ id: "missing", name: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(client.tasks.delete({ id: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("アーカイブ（#241）", () => {
  test("アーカイブして復元しても、状態・環境・ゴール・リンク・スレッドの所属が残る", async () => {
    const { client } = await setup();
    const task = await client.tasks.create({ name: "認可基盤" });
    await client.tasks.updateProgress({
      id: task.id,
      status: "on_hold",
      progressNote: "レビュー待ち",
      nextAction: "PR を出す",
    });
    await client.links.create({
      taskId: task.id,
      url: "https://example.com",
      label: "設計資料",
    });
    const chat = await client.chats.create({ taskId: task.id });

    const archived = await client.tasks.setArchived({
      id: task.id,
      archived: true,
    });
    expect(archived.archivedAt).toBeInstanceOf(Date);
    // 一覧には残り（直接のリンクから開けるように）、アーカイブ済みと分かる
    expect(
      (await client.tasks.list()).find((t) => t.id === task.id)?.archivedAt,
    ).toEqual(archived.archivedAt);
    // もう一度アーカイブしても日時は変わらない
    expect(
      (await client.tasks.setArchived({ id: task.id, archived: true }))
        .archivedAt,
    ).toEqual(archived.archivedAt);

    const restored = await client.tasks.setArchived({
      id: task.id,
      archived: false,
    });
    expect(restored).toMatchObject({
      archivedAt: null,
      status: "on_hold",
      progressNote: "レビュー待ち",
      nextAction: "PR を出す",
      environmentId: task.environmentId,
      wikiId: task.wikiId,
    });
    expect(
      (await client.links.list({ taskId: task.id })).map((l) => l.label),
    ).toEqual(["設計資料"]);
    expect(
      (await client.chats.list()).find((c) => c.id === chat.id)?.taskId,
    ).toBe(task.id);
  });

  test("存在しないタスクは NOT_FOUND", async () => {
    const { client } = await setup();
    expect(
      client.tasks.setArchived({ id: "missing", archived: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("会話の所属", () => {
  test("タスクに会話を作ると、一覧で taskId が分かる", async () => {
    const { client } = await setup();
    const task = await client.tasks.create({ name: "p" });
    const inTask = await client.chats.create({ taskId: task.id });
    const loose = await client.chats.create({});
    expect(inTask.taskId).toBe(task.id);
    expect(loose.taskId).toBeNull();
    const list = await client.chats.list();
    expect(
      Object.fromEntries(list.map((chat) => [chat.id, chat.taskId])),
    ).toEqual({ [inTask.id]: task.id, [loose.id]: null });
  });

  test("既存の会話を追加すると、メッセージとセッションを引き継いで続けられる", async () => {
    const { client, calls } = await setup();
    const chat = await client.chats.create({});
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "1" }],
        },
      }),
    );
    const task = await client.tasks.create({ name: "p" });
    const moved = await client.chats.setTask({
      id: chat.id,
      taskId: task.id,
    });
    expect(moved).toMatchObject({ taskId: task.id, hasSession: true });
    expect((await client.chats.get({ id: chat.id })).messages).toHaveLength(2);

    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: {
          id: "u2",
          role: "user",
          parts: [{ type: "text", text: "2" }],
        },
      }),
    );
    // 移動前と同じ Claude Code セッションを resume する
    const result = (await loadFixture("text-partial")).find(
      (line) => line.type === "result",
    ) as { session_id: string };
    expect(calls[0]?.options?.resume).toBeUndefined();
    expect(calls[1]?.options?.resume).toBe(result.session_id);
  });

  test("タスクから外すと未所属に戻り、タスクを消しても会話は残る", async () => {
    const { client } = await setup();
    const task = await client.tasks.create({ name: "p" });
    const a = await client.chats.create({ taskId: task.id });
    const b = await client.chats.create({ taskId: task.id });
    expect(
      (await client.chats.setTask({ id: a.id, taskId: null })).taskId,
    ).toBeNull();
    await client.tasks.delete({ id: task.id });
    expect((await client.chats.get({ id: b.id })).chat.taskId).toBeNull();
  });

  test("存在しないタスクには作れない・追加できない", async () => {
    const { client } = await setup();
    const chat = await client.chats.create({});
    expect(client.chats.create({ taskId: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      client.chats.setTask({ id: chat.id, taskId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      client.chats.setTask({ id: "missing", taskId: null }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
