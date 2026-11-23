import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { router } from "../../src/router.ts";
import { createScriptedQuery } from "../e2e/scripted-query.ts";
import { createTestContext } from "../helpers/context.ts";

const setup = () => {
  const ctx = createTestContext({ query: createScriptedQuery() });
  return createRouterClient(router, { context: ctx.context });
};

const drain = async (iterable: AsyncIterable<unknown>) => {
  for await (const _ of iterable) {
    // 読み切る
  }
};

describe("プロジェクトの進捗", () => {
  test("作成時は未着手・空欄で、最終更新日時は無い", async () => {
    const client = setup();
    const project = await client.projects.create({ name: "認可基盤" });
    expect(project).toMatchObject({
      status: "not_started",
      progressNote: "",
      nextAction: "",
      progressUpdatedAt: null,
    });
  });

  test("状態・進捗メモ・次にやることを保存でき、別のプロジェクトには反映されない", async () => {
    const client = setup();
    const a = await client.projects.create({ name: "a" });
    const b = await client.projects.create({ name: "b" });
    const updated = await client.projects.updateProgress({
      id: a.id,
      status: "in_progress",
      progressNote: "設計と調査を進めた",
      nextAction: " 検証環境で権限モデルを試す ",
    });
    expect(updated).toMatchObject({
      status: "in_progress",
      progressNote: "設計と調査を進めた",
      nextAction: "検証環境で権限モデルを試す",
    });
    expect(updated.progressUpdatedAt).not.toBeNull();

    // 指定しなかった項目は変わらない
    const onHold = await client.projects.updateProgress({
      id: a.id,
      status: "on_hold",
    });
    expect(onHold).toMatchObject({
      status: "on_hold",
      progressNote: "設計と調査を進めた",
      nextAction: "検証環境で権限モデルを試す",
    });

    const list = await client.projects.list();
    expect(list.find((p) => p.id === b.id)).toMatchObject({
      status: "not_started",
      progressNote: "",
      nextAction: "",
      progressUpdatedAt: null,
    });
  });

  test("完了したプロジェクトも進行中に戻せる", async () => {
    const client = setup();
    const project = await client.projects.create({ name: "p" });
    await client.projects.updateProgress({ id: project.id, status: "done" });
    expect(
      (
        await client.projects.updateProgress({
          id: project.id,
          status: "in_progress",
        })
      ).status,
    ).toBe("in_progress");
  });

  test("スレッドで会話を続けても、状態と進捗の最終更新日時は変わらない", async () => {
    const client = setup();
    const project = await client.projects.create({ name: "p" });
    const progressed = await client.projects.updateProgress({
      id: project.id,
      status: "in_progress",
    });
    const chat = await client.chats.create({ projectId: project.id });
    await Bun.sleep(5);
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "続き" }],
        },
      }),
    );
    await drain(await client.chat.regenerate({ chatId: chat.id }));
    const [after] = await client.projects.list();
    expect(after?.status).toBe("in_progress");
    expect(after?.progressUpdatedAt).toEqual(progressed.progressUpdatedAt);
  });

  test("不正な状態は BAD_REQUEST、存在しないプロジェクトは NOT_FOUND", async () => {
    const client = setup();
    const project = await client.projects.create({ name: "p" });
    expect(
      client.projects.updateProgress({
        id: project.id,
        status: "archived" as never,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      client.projects.updateProgress({ id: "missing", status: "done" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
