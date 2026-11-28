import { beforeEach, describe, expect, test } from "bun:test";
import { createRouterClient, type RouterClient } from "@orpc/server";
import type { ChatRepository } from "../../src/db/chat-repository.ts";
import { type Router, router } from "../../src/router.ts";
import { createTestContext } from "../helpers/context.ts";

let client: RouterClient<Router>;
let repo: ChatRepository;

beforeEach(() => {
  const { context, chats } = createTestContext();
  repo = chats;
  client = createRouterClient(router, { context });
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

describe("system.status", () => {
  test("Claude Code の状態とモデル一覧を返す", async () => {
    const { context } = createTestContext();
    await context.claude.ready;
    const status = await createRouterClient(router, {
      context,
    }).system.status();
    expect(status).toMatchObject({
      cwd: "/work",
      claude: {
        state: "ready",
        version: "2.1.330",
        account: { subscriptionType: "Claude Max" },
        models: [{ value: "default" }],
      },
    });
  });
});

describe("会話に使う AI（#265）", () => {
  test("使える AI を選んで会話を作る。選ばなければ Claude Code", async () => {
    const ctx = createTestContext();
    const client = createRouterClient(router, { context: ctx.context });
    const status = await client.system.status();
    expect(status.agents.codex.state).toBe("ready");
    const codex = await client.chats.create({
      agent: "codex",
      model: "gpt-test",
    });
    expect(codex.agent).toBe("codex");
    // 既存の会話・選ばずに作った会話は Claude Code
    expect((await client.chats.create({})).agent).toBe("claude-code");
  });

  test("使えない AI を選ぶと、理由と設定の手順を返す", async () => {
    const ctx = createTestContext();
    const client = createRouterClient(router, { context: ctx.context });
    await expect(
      client.chats.create({ agent: "copilot" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("見つかりません"),
    });
  });
});
