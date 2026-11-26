import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { router } from "../../src/router.ts";
import { REASONS } from "../../src/task/goal-runs.ts";
import {
  type GoalVerdict,
  parseGoalVerdict,
} from "../../src/task/goal-verdict.ts";
import { createTestContext } from "../helpers/context.ts";
import { createFakeQuery, loadFixture } from "../provider/fake-query.ts";

const setup = async (verdict: GoalVerdict = { kind: "none", reason: "" }) => {
  const fake = createFakeQuery(await loadFixture("text-partial"));
  const current = { verdict };
  const ctx = createTestContext({
    query: fake.query,
    taskContext: true,
    readVerdict: async () => current.verdict,
  });
  const client = createRouterClient(router, { context: ctx.context });
  return { ...ctx, ...fake, client, current };
};

const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out");
};

const drain = async (iterable: AsyncIterable<unknown>) => {
  for await (const _ of iterable) {
    // 読み切る
  }
};

type Client = Awaited<ReturnType<typeof setup>>["client"];

/** ゴールを設定したタスクを作る。 */
const taskWithGoal = async (client: Client, goal = "テストがすべて通る") => {
  const task = await client.tasks.create({ name: "認可基盤" });
  await client.tasks.updateProgress({ id: task.id, nextAction: goal });
  return task;
};

/** 実行を始め、最初の生成が終わって状態が変わるまで待つ。 */
const runToEnd = async (client: Client, taskId: string) => {
  const { chatId, run } = await client.tasks.runGoal({ id: taskId });
  await drain(await client.chat.reconnect({ chatId }));
  await waitFor(
    async () =>
      (await client.tasks.goalRun({ id: taskId }))?.state !== "running",
  );
  return { chatId, run };
};

const statusOf = async (client: Client, taskId: string) =>
  (await client.tasks.list()).find((t) => t.id === taskId)?.status;

describe("parseGoalVerdict（#198）", () => {
  const line = (attachment: Record<string, unknown>) =>
    JSON.stringify({ type: "attachment", attachment });

  test("最後の評価を読み、ゴールを設定したときの印は除く", () => {
    const sentinel = line({ type: "goal_status", met: false, sentinel: true });
    expect(parseGoalVerdict(sentinel)).toEqual({ kind: "none", reason: "" });
    expect(
      parseGoalVerdict(
        [
          sentinel,
          line({ type: "goal_status", met: false, reason: "まだ" }),
          "{壊れた行",
          line({ type: "goal_status", met: true, reason: "達成" }),
        ].join("\n"),
      ),
    ).toEqual({ kind: "met", reason: "達成" });
    expect(
      parseGoalVerdict(
        line({ type: "goal_status", met: false, failed: true, reason: "不能" }),
      ),
    ).toEqual({ kind: "failed", reason: "不能" });
  });
});

describe("ゴールの実行（#198）", () => {
  test("タスクのスレッドを作り、/goal をそのまま送って進行中にする。達成を確認したら完了", async () => {
    const { client, calls } = await setup({ kind: "met", reason: "達成" });
    const task = await taskWithGoal(client);
    const { chatId, run } = await runToEnd(client, task.id);
    expect(run).toMatchObject({ goal: "テストがすべて通る", chatId });
    const chat = await client.chats.get({ id: chatId });
    expect(chat.chat.taskId).toBe(task.id);
    // スラッシュコマンドは、タスクの参照情報を付けずに文字列のまま送る
    expect(calls[0]?.prompt).toBe("/goal テストがすべて通る");
    expect(await client.tasks.goalRun({ id: task.id })).toMatchObject({
      state: "achieved",
      reason: "達成",
    });
    expect(await statusOf(client, task.id)).toBe("done");
  });

  test("達成不能なら保留、判定できなければ要確認にして理由を残す", async () => {
    const failed = await setup({ kind: "failed", reason: "矛盾している" });
    const a = await taskWithGoal(failed.client);
    await runToEnd(failed.client, a.id);
    expect(await failed.client.tasks.goalRun({ id: a.id })).toMatchObject({
      state: "failed",
      reason: "矛盾している",
    });
    expect(await statusOf(failed.client, a.id)).toBe("on_hold");

    const unknown = await setup();
    const b = await taskWithGoal(unknown.client);
    const { chatId } = await runToEnd(unknown.client, b.id);
    expect(await unknown.client.tasks.goalRun({ id: b.id })).toMatchObject({
      state: "needs_review",
      reason: REASONS.undetermined,
    });
    expect(await statusOf(unknown.client, b.id)).toBe("needs_review");

    // 実行のスレッドで対応して再開すると進行中に戻り、達成すれば完了
    unknown.current.verdict = { kind: "met", reason: "達成" };
    await drain(
      await unknown.client.chat.send({
        chatId,
        message: {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "方針 A で進めて" }],
        },
      }),
    );
    await waitFor(
      async () =>
        (await unknown.client.tasks.goalRun({ id: b.id }))?.state ===
        "achieved",
    );
    expect(await statusOf(unknown.client, b.id)).toBe("done");
  });

  test("ツールの承認待ちで要確認、承認されたら進行中に戻る", async () => {
    const { client, context } = await setup();
    const task = await taskWithGoal(client);
    const { chatId } = await client.tasks.runGoal({ id: task.id });
    context.goalRuns.onPendingChange(chatId, 1);
    expect(await client.tasks.goalRun({ id: task.id })).toMatchObject({
      state: "needs_review",
      reason: REASONS.approval,
    });
    expect(await statusOf(client, task.id)).toBe("needs_review");
    context.goalRuns.onPendingChange(chatId, 0);
    expect((await client.tasks.goalRun({ id: task.id }))?.state).toBe(
      "running",
    );
    expect(await statusOf(client, task.id)).toBe("in_progress");
    await drain(await client.chat.reconnect({ chatId }));
  });

  test("ゴールが無いと実行できず、実行中は多重に起動しない。止めると保留にして再実行できる", async () => {
    const { client, context } = await setup();
    const empty = await client.tasks.create({ name: "ゴールなし" });
    await expect(client.tasks.runGoal({ id: empty.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    const task = await taskWithGoal(client);
    const first = await runToEnd(client, task.id);
    // 要確認（判定なし）の間も、進行中として扱う
    await expect(client.tasks.runGoal({ id: task.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const threads = (await client.chats.list()).filter(
      (chat) => chat.taskId === task.id,
    );
    expect(threads).toHaveLength(1);

    expect(await client.tasks.stopGoal({ id: task.id })).toMatchObject({
      state: "stopped",
    });
    expect(await statusOf(client, task.id)).toBe("on_hold");
    await expect(client.tasks.stopGoal({ id: task.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // 再実行すると新しいスレッドになり、過去の実行のスレッドのイベントでは更新しない
    const second = await client.tasks.runGoal({ id: task.id });
    expect(second.chatId).not.toBe(first.chatId);
    context.goalRuns.onPendingChange(first.chatId, 1);
    expect((await client.tasks.goalRun({ id: task.id }))?.state).toBe(
      "running",
    );
    await drain(await client.chat.reconnect({ chatId: second.chatId }));
  });

  test("通常のスレッドのイベントでは、タスクの進捗を変えない", async () => {
    const { client, context } = await setup({ kind: "met", reason: "" });
    const task = await taskWithGoal(client);
    const chat = await client.chats.create({ taskId: task.id });
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "ふつうの質問" }],
        },
      }),
    );
    context.goalRuns.onPendingChange(chat.id, 1);
    await Bun.sleep(30);
    expect(await statusOf(client, task.id)).toBe("not_started");
    expect(await client.tasks.goalRun({ id: task.id })).toBeNull();
  });
});
