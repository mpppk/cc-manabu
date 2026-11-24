import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { router } from "../../src/router.ts";
import { createTestContext } from "../helpers/context.ts";

const setup = () => {
  const ctx = createTestContext();
  return createRouterClient(router, { context: ctx.context });
};

describe("関連リンク", () => {
  test("複数登録でき、登録した順に並び、編集・削除が反映される", async () => {
    const client = setup();
    const task = await client.tasks.create({ name: "認可基盤" });
    const repo = await client.links.create({
      taskId: task.id,
      url: " https://github.com/example/authz ",
      label: " リポジトリ ",
    });
    await Bun.sleep(2);
    const doc = await client.links.create({
      taskId: task.id,
      url: "https://example.com/design",
      label: "",
    });
    expect(repo).toMatchObject({
      url: "https://github.com/example/authz",
      label: "リポジトリ",
    });
    // 表示名を省略すると null（URL を表示する）
    expect(doc.label).toBeNull();
    expect(
      (await client.links.list({ taskId: task.id })).map((l) => l.id),
    ).toEqual([repo.id, doc.id]);

    const edited = await client.links.update({
      id: doc.id,
      url: "http://example.com/design/v2",
      label: "設計資料",
    });
    expect(edited).toMatchObject({
      url: "http://example.com/design/v2",
      label: "設計資料",
    });
    await client.links.delete({ id: repo.id });
    expect(await client.links.list({ taskId: task.id })).toEqual([edited]);
  });

  test("リンクはタスクごと。タスクを消すと一緒に消える", async () => {
    const client = setup();
    const a = await client.tasks.create({ name: "a" });
    const b = await client.tasks.create({ name: "b" });
    await client.links.create({ taskId: a.id, url: "https://a.example" });
    await client.links.create({ taskId: b.id, url: "https://b.example" });
    expect(
      (await client.links.list({ taskId: a.id })).map((l) => l.url),
    ).toEqual(["https://a.example"]);
    await client.tasks.delete({ id: b.id });
    expect(client.links.list({ taskId: b.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test.each([
    ["javascript:alert(1)"],
    ["file:///etc/passwd"],
    ["ftp://example.com"],
    ["not a url"],
    [""],
  ])("http / https 以外の URL（%s）は BAD_REQUEST", async (url) => {
    const client = setup();
    const task = await client.tasks.create({ name: "p" });
    expect(client.links.create({ taskId: task.id, url })).rejects.toMatchObject(
      { code: "BAD_REQUEST" },
    );
  });

  test("存在しないタスク・リンクは NOT_FOUND", async () => {
    const client = setup();
    expect(
      client.links.create({ taskId: "missing", url: "https://x.example" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      client.links.update({ id: "missing", url: "https://x.example" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(client.links.delete({ id: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
