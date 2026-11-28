import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { router } from "../../src/router.ts";
import { createTestContext } from "../helpers/context.ts";

const setup = async () => {
  const ctx = createTestContext();
  const client = createRouterClient(router, { context: ctx.context });
  /** セッションを持ち、質問と回答を 1 組保存した会話。 */
  const chatWithSession = async (sessionId: string) => {
    const chat = await client.chats.create({ model: "haiku" });
    ctx.chats.updateChat(chat.id, { sessionId });
    ctx.chats.saveMessage(chat.id, {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "質問" }],
    });
    ctx.chats.saveMessage(chat.id, {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: "回答" }],
      sdkUuid: `${sessionId}-a1`,
    });
    return chat;
  };
  return { ...ctx, client, chatWithSession };
};

describe("chats.sessionSync（#244）", () => {
  test("セッションがまだ無い会話は no_session", async () => {
    const { client } = await setup();
    const chat = await client.chats.create({ model: "haiku" });
    expect(await client.chats.sessionSync({ id: chat.id })).toEqual({
      state: "no_session",
    });
  });

  test("Desktop・CLI で足した質問があれば、確認し直しても未取り込みのまま。Monet の履歴は変えない", async () => {
    const { client, chatWithSession, sessions } = await setup();
    const chat = await chatWithSession("s1");
    expect(await client.chats.sessionSync({ id: chat.id })).toEqual({
      state: "synced",
    });
    sessions.appendExternal("s1", "Desktop の質問");
    const expected = { state: "unimported" as const, prompts: 1 };
    expect(await client.chats.sessionSync({ id: chat.id })).toEqual(expected);
    expect(await client.chats.sessionSync({ id: chat.id })).toEqual(expected);
    expect((await client.chats.get({ id: chat.id })).messages).toHaveLength(2);
  });

  test("タイトルの変更など、更新日時だけが変わったときは未取り込みにしない", async () => {
    const { client, chatWithSession, sessions } = await setup();
    const chat = await chatWithSession("s1");
    sessions.touch("s1");
    expect(await client.chats.sessionSync({ id: chat.id })).toEqual({
      state: "synced",
    });
  });

  test("別の分岐（別のセッション）に足した質問は、表示中の会話に出さない", async () => {
    const { client, chatWithSession, sessions } = await setup();
    const main = await chatWithSession("s1");
    const other = await chatWithSession("s2");
    sessions.appendExternal("s2", "分岐の質問");
    expect(await client.chats.sessionSync({ id: main.id })).toEqual({
      state: "synced",
    });
    expect(await client.chats.sessionSync({ id: other.id })).toEqual({
      state: "unimported",
      prompts: 1,
    });
  });

  test("生成中・承認待ちは照合しない", async () => {
    const { client, chatWithSession, chats } = await setup();
    const chat = await chatWithSession("s1");
    chats.setStatus(chat.id, "awaiting_approval");
    expect(await client.chats.sessionSync({ id: chat.id })).toEqual({
      state: "busy",
    });
  });

  test("存在しない会話は NOT_FOUND", async () => {
    const { client } = await setup();
    expect(client.chats.sessionSync({ id: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("chats.openInDesktop（#244）", () => {
  test("表示中の会話のセッションを、その作業ディレクトリから開く", async () => {
    const { client, chatWithSession, sessions } = await setup();
    const chat = await chatWithSession("s1");
    await client.chats.openInDesktop({ id: chat.id });
    expect(sessions.launches).toEqual([{ sessionId: "s1", cwd: chat.cwd }]);
  });

  test("セッションが無い・生成中なら理由を付けて断る", async () => {
    const { client, chatWithSession, chats, sessions } = await setup();
    const blank = await client.chats.create({ model: "haiku" });
    expect(client.chats.openInDesktop({ id: blank.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("セッションがありません"),
    });
    const chat = await chatWithSession("s1");
    chats.setStatus(chat.id, "running");
    expect(client.chats.openInDesktop({ id: chat.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("生成中・承認待ち"),
    });
    expect(sessions.launches).toEqual([]);
  });

  test("起動に失敗したら理由を返す", async () => {
    const { client, chatWithSession, sessions } = await setup();
    const chat = await chatWithSession("s1");
    sessions.failLaunch("unknown option '--desktop'");
    expect(client.chats.openInDesktop({ id: chat.id })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: expect.stringContaining("unknown option '--desktop'"),
    });
  });
});
