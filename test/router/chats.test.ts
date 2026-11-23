import { beforeEach, describe, expect, test } from "bun:test";
import { createRouterClient, type RouterClient } from "@orpc/server";
import { Result } from "@praha/byethrow";
import {
  type ChatRepository,
  createChatRepository,
} from "../../src/db/chat-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import { type Router, router } from "../../src/router.ts";

let client: RouterClient<Router>;
let repo: ChatRepository;

beforeEach(() => {
  const opened = openDatabase(":memory:");
  if (Result.isFailure(opened)) throw opened.error;
  repo = createChatRepository(opened.value.db);
  client = createRouterClient(router, {
    context: { chats: repo, cwd: "/work" },
  });
});

describe("chats", () => {
  test("作成した会話は起動時の cwd を持ち、一覧に出る", async () => {
    const created = await client.chats.create({ model: "sonnet" });
    expect(created).toMatchObject({
      cwd: "/work",
      model: "sonnet",
      status: "idle",
      hasSession: false,
    });
    expect((await client.chats.list()).map((c) => c.id)).toEqual([created.id]);
  });

  test("メッセージ込みで取得できる", async () => {
    const chat = await client.chats.create({});
    repo.saveMessage(chat.id, {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const result = await client.chats.get({ id: chat.id });
    expect(result.messages).toEqual([
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        metadata: undefined,
      },
    ]);
  });

  test("名前変更（前後の空白は取り除く）と削除", async () => {
    const chat = await client.chats.create({});
    expect(
      (await client.chats.rename({ id: chat.id, title: "  新しい名前  " }))
        .title,
    ).toBe("新しい名前");
    await client.chats.delete({ id: chat.id });
    expect(await client.chats.list()).toEqual([]);
  });

  test("存在しない会話は NOT_FOUND", async () => {
    expect(client.chats.get({ id: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(client.chats.delete({ id: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("空のタイトルは BAD_REQUEST", async () => {
    const chat = await client.chats.create({});
    expect(
      client.chats.rename({ id: chat.id, title: "   " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
