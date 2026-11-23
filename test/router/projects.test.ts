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

describe("projects", () => {
  test("作成・一覧・名前変更・削除", async () => {
    const { client } = await setup();
    const a = await client.projects.create({ name: " 認可基盤 " });
    const b = await client.projects.create({ name: "家計簿" });
    expect(a.name).toBe("認可基盤");
    expect((await client.projects.list()).map((p) => p.name)).toEqual([
      "認可基盤",
      "家計簿",
    ]);
    expect(
      (await client.projects.rename({ id: a.id, name: "認可" })).name,
    ).toBe("認可");
    await client.projects.delete({ id: b.id });
    expect((await client.projects.list()).map((p) => p.id)).toEqual([a.id]);
  });

  test("空の名前は BAD_REQUEST、存在しないプロジェクトは NOT_FOUND", async () => {
    const { client } = await setup();
    expect(client.projects.create({ name: "  " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(
      client.projects.rename({ id: "missing", name: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(client.projects.delete({ id: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("会話の所属", () => {
  test("プロジェクトに会話を作ると、一覧で projectId が分かる", async () => {
    const { client } = await setup();
    const project = await client.projects.create({ name: "p" });
    const inProject = await client.chats.create({ projectId: project.id });
    const loose = await client.chats.create({});
    expect(inProject.projectId).toBe(project.id);
    expect(loose.projectId).toBeNull();
    const list = await client.chats.list();
    expect(
      Object.fromEntries(list.map((chat) => [chat.id, chat.projectId])),
    ).toEqual({ [inProject.id]: project.id, [loose.id]: null });
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
    const project = await client.projects.create({ name: "p" });
    const moved = await client.chats.setProject({
      id: chat.id,
      projectId: project.id,
    });
    expect(moved).toMatchObject({ projectId: project.id, hasSession: true });
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

  test("プロジェクトから外すと未所属に戻り、プロジェクトを消しても会話は残る", async () => {
    const { client } = await setup();
    const project = await client.projects.create({ name: "p" });
    const a = await client.chats.create({ projectId: project.id });
    const b = await client.chats.create({ projectId: project.id });
    expect(
      (await client.chats.setProject({ id: a.id, projectId: null })).projectId,
    ).toBeNull();
    await client.projects.delete({ id: project.id });
    expect((await client.chats.get({ id: b.id })).chat.projectId).toBeNull();
  });

  test("存在しないプロジェクトには作れない・追加できない", async () => {
    const { client } = await setup();
    const chat = await client.chats.create({});
    expect(client.chats.create({ projectId: "missing" })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    expect(
      client.chats.setProject({ id: chat.id, projectId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      client.chats.setProject({ id: "missing", projectId: null }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
