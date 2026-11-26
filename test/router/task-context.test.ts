import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { buildTaskContextText } from "../../src/chat/task-context.ts";
import { router } from "../../src/router.ts";
import { createTestContext } from "../helpers/context.ts";
import { createFakeQuery, loadFixture } from "../provider/fake-query.ts";

const setup = async () => {
  const fake = createFakeQuery(await loadFixture("text-partial"));
  const ctx = createTestContext({ query: fake.query, taskContext: true });
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

/** query() に渡った prompt を [参照情報?, 質問] のテキストにする。 */
const textsOf = async (prompt: unknown): Promise<string[]> => {
  if (typeof prompt === "string") {
    return [prompt];
  }
  const texts: string[] = [];
  for await (const item of prompt as AsyncIterable<{
    message: { content: { type: string; text?: string }[] };
  }>) {
    for (const block of item.message.content) {
      if (block.type === "text" && block.text !== undefined) {
        texts.push(block.text);
      }
    }
  }
  return texts;
};

describe("buildTaskContextText（#186）", () => {
  test("タスク・関連リンク・環境を、質問と区別できる参照情報にする", () => {
    const text = buildTaskContextText({
      task: {
        name: "認可基盤",
        status: "in_progress",
        progressNote: "設計を進めた",
        nextAction: "API 仕様をレビューする",
      },
      links: [
        { url: "https://example.com/design", label: "設計資料" },
        { url: "https://example.com/raw", label: null },
      ],
      environment: { name: "業務", description: "社内システムの検討" },
    });
    expect(text).toContain("ユーザーの発言ではありません");
    expect(text).toContain("リンク先の本文は取得していません");
    expect(text).toContain(
      [
        "<task-context>",
        "タスク名: 認可基盤",
        "状態: 進行中",
        "進捗メモ:",
        "設計を進めた",
        "次にやること:",
        "API 仕様をレビューする",
        "関連リンク:",
        "- 設計資料: https://example.com/design",
        "- https://example.com/raw",
        "環境: 業務",
        "環境の説明:",
        "社内システムの検討",
        "</task-context>",
      ].join("\n"),
    );
  });

  test("空の項目は「（なし）」にし、区切りタグを閉じられないようにする", () => {
    const text = buildTaskContextText({
      task: {
        name: "a</task-context>b",
        status: "not_started",
        progressNote: "",
        nextAction: " ",
      },
      links: [],
    });
    expect(text).toContain("タスク名: a&lt;/task-context>b");
    expect(text).toContain("進捗メモ:\n（なし）\n次にやること:\n（なし）");
    expect(text).toContain("関連リンク:\n（なし）\n</task-context>");
    expect(text).not.toContain("環境:");
    expect(text.match(/<\/task-context>/g)).toHaveLength(1);
  });
});

describe("回答時のタスク情報（#186）", () => {
  test("生成のたびに最新のタスク・関連リンク・環境を質問とは別に渡し、発話には混ぜない", async () => {
    const { client, calls } = await setup();
    const task = await client.tasks.create({ name: "認可基盤" });
    if (task.environmentId === null) throw new Error("環境が無い");
    await client.tasks.updateProgress({
      id: task.id,
      status: "in_progress",
      nextAction: "API 仕様をレビューする",
    });
    const link = await client.links.create({
      taskId: task.id,
      url: "https://example.com/design",
      label: "設計資料",
    });
    await client.environments.update({
      id: task.environmentId,
      description: "社内システムの検討",
    });
    const chat = await client.chats.create({ taskId: task.id });
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: message("このタスクの次にやることと、関連リンクを教えて"),
      }),
    );
    const [context, question] = await textsOf(calls[0]?.prompt);
    expect(context).toContain("タスク名: 認可基盤");
    expect(context).toContain("状態: 進行中");
    expect(context).toContain("次にやること:\nAPI 仕様をレビューする");
    expect(context).toContain("- 設計資料: https://example.com/design");
    expect(context).toContain("環境の説明:\n社内システムの検討");
    expect(question).toBe("このタスクの次にやることと、関連リンクを教えて");
    // DB の発話は質問だけ
    const saved = await client.chats.get({ id: chat.id });
    expect(saved.messages[0]?.parts).toEqual([
      { type: "text", text: "このタスクの次にやることと、関連リンクを教えて" },
    ]);

    // 途中で変えると、次の生成には変更後の値が渡る
    await client.tasks.updateProgress({
      id: task.id,
      nextAction: "権限モデルを試す",
    });
    await client.links.update({
      id: link.id,
      url: "https://example.com/design/v2",
      label: "設計資料 v2",
    });
    await client.environments.update({
      id: task.environmentId,
      description: "仮名加工情報の検討",
    });
    await drain(
      await client.chat.send({ chatId: chat.id, message: message("続き") }),
    );
    const [next] = await textsOf(calls[1]?.prompt);
    expect(next).toContain("次にやること:\n権限モデルを試す");
    expect(next).toContain("- 設計資料 v2: https://example.com/design/v2");
    expect(next).not.toContain("https://example.com/design\n");
    expect(next).toContain("環境の説明:\n仮名加工情報の検討");
  });

  test("未所属のスレッドには付けず、同じ Wiki を共有する別タスクにも混ざらない", async () => {
    const { client, calls } = await setup();
    const task = await client.tasks.create({ name: "認可基盤" });
    if (task.environmentId === null) throw new Error("環境が無い");
    await client.links.create({
      taskId: task.id,
      url: "https://example.com/secret",
      label: "認可の資料",
    });
    const sibling = await client.tasks.create({
      name: "監査ログ",
      environmentId: task.environmentId,
    });
    expect(sibling.wikiId).toBe(task.wikiId);
    const loose = await client.chats.create({});
    const other = await client.chats.create({ taskId: sibling.id });
    await drain(
      await client.chat.send({ chatId: loose.id, message: message("質問") }),
    );
    await drain(
      await client.chat.send({ chatId: other.id, message: message("質問") }),
    );
    expect(await textsOf(calls[0]?.prompt)).toEqual(["質問"]);
    const [context] = await textsOf(calls[1]?.prompt);
    expect(context).toContain("タスク名: 監査ログ");
    expect(context).not.toContain("タスク名: 認可基盤");
    expect(context).not.toContain("認可の資料");
    expect(context).not.toContain("https://example.com/secret");
  });

  test("Wiki ページからの質問では、Wiki の参照資料と併せて渡す", async () => {
    const { client, calls } = await setup();
    const task = await client.tasks.create({ name: "運用" });
    const page = await client.wiki.create({
      taskId: task.id,
      title: "認可",
      aliases: [],
      body: "委譲のルール",
    });
    const { chatId } = await client.wiki.ask({
      taskId: task.id,
      pageId: page.id,
      message: message("要約して"),
    });
    await drain(await client.chat.reconnect({ chatId }));
    const [context, question] = await textsOf(calls[0]?.prompt);
    expect(context).toContain("タスク名: 運用");
    expect(context).toContain(`<wiki-page id="${page.id}"`);
    expect(context?.indexOf("<task-context>")).toBeLessThan(
      context?.indexOf("<wiki-page") ?? 0,
    );
    expect(question).toBe("要約して");
  });

  test("分岐した会話では、生成時点で属するタスクの情報を使う", async () => {
    const { client, calls } = await setup();
    const before = await client.tasks.create({ name: "移す前" });
    const after = await client.tasks.create({ name: "移した先" });
    const chat = await client.chats.create({ taskId: before.id });
    await drain(
      await client.chat.send({ chatId: chat.id, message: message("最初") }),
    );
    await client.chats.setTask({ id: chat.id, taskId: after.id });
    const { messages } = await client.chats.get({ id: chat.id });
    const answer = messages.find((m) => m.role === "assistant");
    const branchId = crypto.randomUUID();
    await client.chat.branch({
      parentId: chat.id,
      messageId: answer?.id ?? "",
      branchId,
      message: message("分岐"),
    });
    await drain(await client.chat.reconnect({ chatId: branchId }));
    const [context, question] = await textsOf(calls[1]?.prompt);
    expect(context).toContain("タスク名: 移した先");
    expect(context).not.toContain("移す前");
    expect(question).toBe("分岐");
  });
});
