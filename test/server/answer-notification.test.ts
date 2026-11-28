import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createRouterClient } from "@orpc/server";
import { Result } from "@praha/byethrow";
import { router } from "../../src/router.ts";
import {
  ANSWER_NOTIFICATION_TITLE,
  createAnswerNotifier,
  NotificationError,
  type Notify,
  threadNameForNotification,
} from "../../src/server/answer-notification.ts";
import { createTestContext } from "../helpers/context.ts";
import { waitFor } from "../helpers/wait-for.ts";
import { createFakeQuery, loadFixture } from "../provider/fake-query.ts";

const userMessage = (text: string) => ({
  id: crypto.randomUUID(),
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

const drain = async (iterable: AsyncIterable<unknown>) => {
  for await (const _ of iterable) {
    // 読み切る
  }
};

describe("回答の完了の通知（#264）", () => {
  test("スレッド名は空白をまとめ、空なら「新しいスレッド」、長ければ省略する", () => {
    expect(threadNameForNotification("  設計の\n相談  ")).toBe("設計の 相談");
    expect(threadNameForNotification("")).toBe("新しいスレッド");
    expect(threadNameForNotification("あいうえおかきくけこ", 5)).toBe(
      "あいうえお…",
    );
  });

  test("正常に終わって保存した回答ごとに 1 回、スレッド名を添えて通知する", async () => {
    const lines = await loadFixture("text-partial");
    const fake = createFakeQuery(lines);
    const notified: [string, string][] = [];
    const notify: Notify = async (title, message) => {
      notified.push([title, message]);
      return Result.succeed();
    };
    let notifier: ((event: { chatId: string }) => Promise<void>) | undefined;
    const ctx = createTestContext({
      query: fake.query,
      onAnswerSaved: (event) => void notifier?.(event),
    });
    notifier = createAnswerNotifier({ chats: ctx.chats, notify });
    const client = createRouterClient(router, { context: ctx.context });
    const chat = await client.chats.create({});

    // 複数の接続（タブ・再接続）で読んでも、通知は 1 回
    const stream = await client.chat.send({
      chatId: chat.id,
      message: userMessage("通知の確認"),
    });
    const replay = await client.chat.reconnect({ chatId: chat.id });
    await Promise.all([drain(stream), drain(replay)]);
    await waitFor(() => notified.length === 1);
    const title = (await client.chats.get({ id: chat.id })).chat.title;
    expect(notified).toEqual([
      [ANSWER_NOTIFICATION_TITLE, threadNameForNotification(title)],
    ]);

    // 次の回答でもう 1 回
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: userMessage("もう一度"),
      }),
    );
    await waitFor(() => notified.length === 2);
  });

  test("エラーで終わった回答では通知しない", async () => {
    const fake = createFakeQuery([
      { type: "__error__", message: "Claude Code native binary not found" },
    ]);
    const saved: string[] = [];
    const ctx = createTestContext({
      query: fake.query,
      onAnswerSaved: (event) => saved.push(event.messageId),
    });
    const client = createRouterClient(router, { context: ctx.context });
    const chat = await client.chats.create({});
    await drain(
      await client.chat.send({ chatId: chat.id, message: userMessage("hi") }),
    );
    await waitFor(
      async () =>
        (await client.chats.get({ id: chat.id })).chat.status === "error",
    );
    expect(saved).toEqual([]);
  });

  test("停止した回答では通知しない", async () => {
    const lines = await loadFixture("abort");
    const gate = Promise.withResolvers<void>();
    const fake = createFakeQuery(lines);
    const query: typeof fake.query = (params) => {
      const inner = fake.query(params) as AsyncIterable<SDKMessage>;
      return (async function* () {
        let count = 0;
        for await (const m of inner) {
          if (count++ === 10) await gate.promise;
          yield m;
        }
      })();
    };
    const saved: string[] = [];
    const ctx = createTestContext({
      query,
      onAnswerSaved: (event) => saved.push(event.messageId),
    });
    const client = createRouterClient(router, { context: ctx.context });
    const chat = await client.chats.create({});
    const stream = await client.chat.send({
      chatId: chat.id,
      message: userMessage("数えて"),
    });
    let received = 0;
    const reading = (async () => {
      for await (const _ of stream) received += 1;
    })();
    // 回答の途中まで届いてから止める（中断した回答も保存される）
    await waitFor(() => received >= 3);
    expect(await client.chat.stop({ chatId: chat.id })).toEqual({
      stopped: true,
    });
    gate.resolve();
    await reading;
    await waitFor(() => {
      const r = ctx.chats.getChat(chat.id);
      return r.type === "Success" && r.value.messages.length === 2;
    });
    expect(saved).toEqual([]);
  });

  test("通知に失敗しても例外にせず、警告は最初の 1 回だけ", async () => {
    const lines = await loadFixture("text-partial");
    const ctx = createTestContext({ query: createFakeQuery(lines).query });
    const client = createRouterClient(router, { context: ctx.context });
    const chat = await client.chats.create({});
    const errors: NotificationError[] = [];
    const notifier = createAnswerNotifier({
      chats: ctx.chats,
      notify: async () =>
        Result.fail(new NotificationError({ detail: "許可されていません" })),
      onError: (error) => errors.push(error),
    });
    await notifier({ chatId: chat.id });
    await notifier({ chatId: chat.id });
    // 消えた会話は通知しない
    await notifier({ chatId: "missing" });
    expect(errors.map((e) => e.message)).toEqual(["許可されていません"]);
  });
});
