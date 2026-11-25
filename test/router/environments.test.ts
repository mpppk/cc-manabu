import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouterClient } from "@orpc/server";
import { Result } from "@praha/byethrow";
import { router } from "../../src/router.ts";
import { createTestContext } from "../helpers/context.ts";
import { createFakeQuery, loadFixture } from "../provider/fake-query.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cc-manabu-env-")));
const repo = mkdtempSync(join(root, "repo-"));
const docs = mkdtempSync(join(root, "docs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const setup = async () => {
  const fake = createFakeQuery(await loadFixture("text-partial"));
  const ctx = createTestContext({
    query: fake.query,
    pickDirectory: async () => Result.succeed(repo),
  });
  const client = createRouterClient(router, { context: ctx.context });
  return { ...ctx, ...fake, client };
};

const drain = async (iterable: AsyncIterable<unknown>) => {
  for await (const _ of iterable) {
    // 読み切る
  }
};

const message = (text: string) => ({
  id: crypto.randomUUID(),
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

describe("environments", () => {
  test("作成・一覧・更新。ディレクトリは実在する絶対パスだけ", async () => {
    const { client } = await setup();
    const env = await client.environments.create({
      name: " cc-manabu ",
      directories: [`${repo}/`, docs, repo],
    });
    expect(env).toMatchObject({
      name: "cc-manabu",
      directories: [repo, docs],
      wikiName: "cc-manabu",
      taskCount: 0,
    });
    expect(await client.environments.list()).toEqual([env]);

    await expect(
      client.environments.create({
        name: "x",
        directories: [join(root, "missing")],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("missing"),
    });
    await expect(
      client.environments.create({ name: "x", directories: ["relative"] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.environments.create({ name: "x", directories: [] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const other = await client.environments.create({
      name: "別",
      directories: [docs],
    });
    const updated = await client.environments.update({
      id: env.id,
      name: "改名",
      directories: [docs, repo],
      wikiId: other.wikiId,
    });
    expect(updated).toMatchObject({
      name: "改名",
      directories: [docs, repo],
      wikiId: other.wikiId,
      wikiName: "別",
    });
  });

  test("スレッドは環境の先頭のディレクトリで作り、残りを追加のディレクトリとして渡す", async () => {
    const { client, calls } = await setup();
    const env = await client.environments.create({
      name: "env",
      directories: [repo, docs],
    });
    const task = await client.tasks.create({
      name: "t",
      environmentId: env.id,
    });
    expect(task.environmentId).toBe(env.id);
    expect(task.wikiId).toBe(env.wikiId);
    const chat = await client.chats.create({ taskId: task.id });
    expect(chat.cwd).toBe(repo);

    await drain(
      await client.chat.send({ chatId: chat.id, message: message("a") }),
    );
    expect(calls[0]?.options?.cwd).toBe(repo);
    expect(calls[0]?.options?.additionalDirectories).toEqual([docs]);

    // 先頭を入れ替えても、作ったスレッドの作業ディレクトリは変わらない（resume できるように）
    await client.environments.update({ id: env.id, directories: [docs, repo] });
    await drain(
      await client.chat.send({ chatId: chat.id, message: message("b") }),
    );
    expect(calls[1]?.options?.cwd).toBe(repo);
    expect(calls[1]?.options?.additionalDirectories).toEqual([docs]);
    expect((await client.chats.create({ taskId: task.id })).cwd).toBe(docs);

    // タスクに属さないスレッドは、起動したディレクトリだけ
    const loose = await client.chats.create({});
    expect(loose.cwd).toBe("/work");
    await drain(
      await client.chat.send({ chatId: loose.id, message: message("c") }),
    );
    expect(calls[2]?.options?.cwd).toBe("/work");
    expect(calls[2]?.options?.additionalDirectories).toBeUndefined();
  });

  test("環境を選ばずに作ったタスクは、起動したディレクトリの環境を新しく作る", async () => {
    const { client } = await setup();
    const task = await client.tasks.create({ name: "新規" });
    expect(await client.environments.list()).toMatchObject([
      {
        id: task.environmentId,
        name: "新規",
        directories: ["/work"],
        taskCount: 1,
      },
    ]);
    await expect(
      client.tasks.create({ name: "x", environmentId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("タスクを移すと Wiki も変わり、タスクのない環境だけを消せる", async () => {
    const { client } = await setup();
    const a = await client.environments.create({
      name: "a",
      directories: [repo],
    });
    const b = await client.environments.create({
      name: "b",
      directories: [docs],
    });
    const task = await client.tasks.create({ name: "t", environmentId: a.id });
    await expect(
      client.environments.delete({ id: a.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const moved = await client.tasks.setEnvironment({
      id: task.id,
      environmentId: b.id,
    });
    expect(moved).toMatchObject({ environmentId: b.id, wikiId: b.wikiId });
    await client.environments.delete({ id: a.id });
    expect((await client.environments.list()).map((e) => e.id)).toEqual([b.id]);
    await expect(
      client.environments.delete({ id: a.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("フォルダを選ぶダイアログの結果を返す", async () => {
    const { client } = await setup();
    expect(await client.system.pickDirectory()).toEqual({ path: repo });
  });
});
