import { describe, expect, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { createRouterClient } from "@orpc/server";
import type { QueryFunction } from "../../src/provider/index.ts";
import { router } from "../../src/router.ts";
import { createScriptedQuery } from "../e2e/scripted-query.ts";
import { createTestContext } from "../helpers/context.ts";
import { waitFor } from "../helpers/wait-for.ts";

const setup = () => {
  const scripted = createScriptedQuery();
  const calls: Options[] = [];
  const query: QueryFunction = (params) => {
    calls.push(params.options ?? {});
    return scripted(params);
  };
  const ctx = createTestContext({ query });
  const client = createRouterClient(router, { context: ctx.context });
  return { ...ctx, client, calls };
};

type Client = ReturnType<typeof setup>["client"];

const drain = async (iterable: AsyncIterable<unknown>) => {
  for await (const _ of iterable) {
    // 読み切る
  }
};

const userMessage = (text: string, id = crypto.randomUUID()) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

const send = async (client: Client, chatId: string, text: string) =>
  drain(await client.chat.send({ chatId, message: userMessage(text) }));

const textsOf = async (client: Client, chatId: string) =>
  (await client.chats.get({ id: chatId })).messages.map((m) =>
    (m.parts as { type: string; text?: string }[])
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join(""),
  );

/** 2 往復した会話を作る。 */
const twoTurns = async (client: Client, taskId?: string) => {
  const chat = await client.chats.create(
    taskId === undefined ? {} : { taskId },
  );
  await send(client, chat.id, "設計案は？");
  await send(client, chat.id, "同期で進めて");
  return chat;
};

/** 分岐した会話が自分のターンを終えるまで待つ。 */
const branchFrom = async (
  client: Client,
  parentId: string,
  messageIndex: number,
  text: string,
  selectBranch = true,
) => {
  const { messages } = await client.chats.get({ id: parentId });
  const branchId = crypto.randomUUID();
  const result = await client.chat.branch({
    parentId,
    messageId: messages[messageIndex]?.id ?? "",
    branchId,
    message: userMessage(text),
    ...(selectBranch ? {} : { selectBranch }),
  });
  expect(result.chatId).toBe(branchId);
  await drain(await client.chat.reconnect({ chatId: branchId }));
  await waitFor(
    async () =>
      (await client.chats.get({ id: branchId })).chat.status === "idle",
  );
  return branchId;
};

describe("分岐（#76）", () => {
  test("選んだ回答までの履歴を引き継ぎ、分岐元のセッションをその地点から fork する", async () => {
    const { client, calls } = setup();
    const root = await twoTurns(client);
    const rootSession = calls[1]?.resume;
    const branchId = await branchFrom(client, root.id, 1, "非同期だと？");

    expect(await textsOf(client, branchId)).toEqual([
      "設計案は？",
      "了解: 設計案は？",
      "非同期だと？",
      "了解: 非同期だと？",
    ]);
    // 分岐元の会話はそのまま
    expect(await textsOf(client, root.id)).toEqual([
      "設計案は？",
      "了解: 設計案は？",
      "同期で進めて",
      "了解: 同期で進めて",
    ]);
    const forkCall = calls[2];
    expect(forkCall?.resume).toBe(rootSession);
    expect(forkCall?.resumeSessionAt).toBeString();
    expect(forkCall?.forkSession).toBe(true);

    const { chat } = await client.chats.get({ id: branchId });
    expect(chat).toMatchObject({
      groupId: root.id,
      parentId: root.id,
      inheritedCount: 2,
      branchTitle: "非同期だと？",
      title: "設計案は？",
    });

    // 分岐した会話で続けて送ると、その会話のセッションを resume する（fork しない）
    await send(client, branchId, "その続き");
    expect(calls[3]?.resume).toBeString();
    expect(calls[3]?.resume).not.toBe(rootSession);
    expect(calls[3]?.forkSession).toBeUndefined();
    // 元の会話でも続けられる
    await send(client, root.id, "元の続き");
    expect(calls[4]?.resume).toBe(rootSession);
  });

  test("分岐した会話からさらに分岐でき、スレッドは 1 つのまま。名前・タスク・削除はスレッドごと", async () => {
    const { client } = setup();
    const task = await client.tasks.create({ name: "p" });
    const root = await twoTurns(client, task.id);
    const b1 = await branchFrom(client, root.id, 1, "分岐1");
    const b2 = await branchFrom(client, b1, 3, "分岐2");

    const list = await client.chats.list();
    expect(new Set(list.map((c) => c.groupId))).toEqual(new Set([root.id]));
    expect(list).toHaveLength(3);
    expect((await client.chats.get({ id: b2 })).chat).toMatchObject({
      parentId: b1,
      taskId: task.id,
      inheritedCount: 4,
    });

    await client.chats.rename({ id: b2, title: "API 設計" });
    expect((await client.chats.list()).map((c) => c.title)).toEqual([
      "API 設計",
      "API 設計",
      "API 設計",
    ]);

    await client.chats.setTask({ id: b1, taskId: null });
    expect((await client.chats.list()).map((c) => c.taskId)).toEqual([
      null,
      null,
      null,
    ]);

    await client.chats.delete({ id: root.id });
    expect(await client.chats.list()).toEqual([]);
  });

  test("元の会話を編集・再生成しても、分岐した会話の履歴と再開先は変わらない", async () => {
    const { client, calls } = setup();
    const root = await twoTurns(client);
    const branchId = await branchFrom(client, root.id, 1, "分岐");
    const before = await textsOf(client, branchId);
    const branchSession = (await client.chats.get({ id: branchId })).chat;

    const { messages } = await client.chats.get({ id: root.id });
    await drain(
      await client.chat.edit({
        chatId: root.id,
        messageId: messages[0]?.id ?? "",
        text: "別の設計案は？",
      }),
    );
    await drain(await client.chat.regenerate({ chatId: root.id }));

    expect(await textsOf(client, branchId)).toEqual(before);
    await send(client, branchId, "分岐の続き");
    const last = calls.at(-1);
    expect(last?.forkSession).toBeUndefined();
    expect(branchSession.hasSession).toBe(true);
    expect(await textsOf(client, branchId)).toHaveLength(6);
  });

  test("最後に開いた会話を記録する", async () => {
    const { client } = setup();
    const root = await twoTurns(client);
    const branchId = await branchFrom(client, root.id, 1, "分岐");
    await client.chats.select({ id: root.id });
    const list = await client.chats.list();
    const rootRow = list.find((c) => c.id === root.id);
    const branchRow = list.find((c) => c.id === branchId);
    expect(rootRow?.lastSelectedAt).not.toBeNull();
    expect(
      new Date(rootRow?.lastSelectedAt ?? 0).getTime(),
    ).toBeGreaterThanOrEqual(
      new Date(branchRow?.lastSelectedAt ?? 0).getTime(),
    );
  });

  test("サイドチャットで分岐してもメインで最後に開いた会話は変わらない", async () => {
    const { client, calls } = setup();
    const root = await twoTurns(client);
    await client.chats.select({ id: root.id });
    const before = (await client.chats.get({ id: root.id })).chat
      .lastSelectedAt;
    const side = await branchFrom(client, root.id, 1, "脇道の質問", false);
    expect(
      (await client.chats.get({ id: side })).chat.lastSelectedAt,
    ).toBeNull();
    expect(
      (await client.chats.get({ id: root.id })).chat.lastSelectedAt,
    ).toEqual(before);
    await send(client, root.id, "メインの続き");
    await send(client, side, "脇道の続き");
    expect(calls[3]?.resume).toBe(calls[1]?.resume);
    expect(calls[4]?.resume).not.toBe(calls[3]?.resume);
    expect(await textsOf(client, side)).not.toContain("同期で進めて");
  });

  test("生成と停止は会話ごと", async () => {
    const { client } = setup();
    const root = await twoTurns(client);
    const { messages } = await client.chats.get({ id: root.id });
    const branchId = crypto.randomUUID();
    await client.chat.branch({
      parentId: root.id,
      messageId: messages[1]?.id ?? "",
      branchId,
      message: userMessage("ゆっくり数えて"),
    });
    await waitFor(
      async () =>
        (await client.chats.get({ id: branchId })).chat.status === "running",
    );
    expect((await client.chat.stop({ chatId: root.id })).stopped).toBe(false);
    expect((await client.chats.get({ id: branchId })).chat.status).toBe(
      "running",
    );
    expect((await client.chat.stop({ chatId: branchId })).stopped).toBe(true);
  });

  test("タスクの進捗は分岐しても変わらない", async () => {
    const { client } = setup();
    const task = await client.tasks.create({ name: "p" });
    const progressed = await client.tasks.updateProgress({
      id: task.id,
      status: "in_progress",
    });
    const root = await twoTurns(client, task.id);
    await branchFrom(client, root.id, 1, "分岐");
    const [after] = await client.tasks.list();
    expect(after?.status).toBe("in_progress");
    expect(after?.progressUpdatedAt).toEqual(progressed.progressUpdatedAt);
  });

  test("ユーザー発話や存在しないメッセージからは分岐できない", async () => {
    const { client } = setup();
    const root = await twoTurns(client);
    const { messages } = await client.chats.get({ id: root.id });
    expect(
      client.chat.branch({
        parentId: root.id,
        messageId: messages[0]?.id ?? "",
        branchId: crypto.randomUUID(),
        message: userMessage("x"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      client.chat.branch({
        parentId: "missing",
        messageId: "x",
        branchId: crypto.randomUUID(),
        message: userMessage("x"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("選択範囲を引用して質問（#91）", () => {
  test("引用と質問を区別してモデルに渡し、引用を発話に残す。編集しても引用は消えない", async () => {
    const scripted = createScriptedQuery();
    const prompts: string[] = [];
    const query: QueryFunction = (params) => {
      if (typeof params.prompt === "string") prompts.push(params.prompt);
      return scripted(params);
    };
    const ctx = createTestContext({ query });
    const client = createRouterClient(router, { context: ctx.context });
    const root = await twoTurns(client);
    const { messages } = await client.chats.get({ id: root.id });
    const answer = messages[1];
    const branchId = crypto.randomUUID();
    const quote = {
      type: "data-quote" as const,
      data: {
        text: "方式 B\n失敗時は再送する",
        sourceMessageId: answer?.id ?? "",
      },
    };
    await client.chat.branch({
      parentId: root.id,
      messageId: answer?.id ?? "",
      branchId,
      message: {
        id: "q1",
        role: "user",
        parts: [quote, { type: "text", text: "失敗時はどう復旧する？" }],
      },
    });
    await drain(await client.chat.reconnect({ chatId: branchId }));
    await waitFor(
      async () =>
        (await client.chats.get({ id: branchId })).chat.status === "idle",
    );

    const sent = prompts.at(-1) ?? "";
    expect(sent).toContain("<quote>\n方式 B\n失敗時は再送する\n</quote>");
    expect(sent.indexOf("</quote>")).toBeLessThan(
      sent.indexOf("失敗時はどう復旧する？"),
    );
    const branch = await client.chats.get({ id: branchId });
    expect(branch.chat.branchTitle).toBe("失敗時はどう復旧する？");
    expect(branch.messages[2]?.parts).toEqual([
      quote,
      { type: "text", text: "失敗時はどう復旧する？" },
    ]);

    await drain(
      await client.chat.edit({
        chatId: branchId,
        messageId: "q1",
        text: "失敗時の通知は？",
      }),
    );
    expect(
      (await client.chats.get({ id: branchId })).messages[2]?.parts,
    ).toEqual([quote, { type: "text", text: "失敗時の通知は？" }]);
    expect(prompts.at(-1)).toContain("<quote>");
  });

  test("空の引用は BAD_REQUEST", async () => {
    const { client } = setup();
    const root = await twoTurns(client);
    const { messages } = await client.chats.get({ id: root.id });
    expect(
      client.chat.branch({
        parentId: root.id,
        messageId: messages[1]?.id ?? "",
        branchId: crypto.randomUUID(),
        message: {
          id: "q",
          role: "user",
          parts: [
            { type: "data-quote", data: { text: " ", sourceMessageId: "x" } },
            { type: "text", text: "質問" },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
