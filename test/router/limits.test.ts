import { expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { router } from "../../src/router.ts";
import { createScriptedQuery } from "../e2e/scripted-query.ts";
import { createTestContext } from "../helpers/context.ts";

test("回答のたびに届く利用枠を保存し、limits.get で返す（#116）", async () => {
  const { context } = createTestContext({ query: createScriptedQuery() });
  const client = createRouterClient(router, { context });
  expect(await client.limits.get()).toBeNull();

  const chat = await client.chats.create({});
  const before = Date.now();
  for await (const _ of await client.chat.send({
    chatId: chat.id,
    message: {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: "こんにちは" }],
    },
  })) {
    // 読み切る
  }
  const limits = await client.limits.get();
  expect(limits?.status).toBe("allowed");
  expect(limits?.observedAt).toBeGreaterThanOrEqual(before);
  expect(limits?.windows.map((w) => [w.type, w.utilization])).toEqual([
    ["five_hour", 0.62],
    ["seven_day", 0.67],
  ]);
  expect(limits?.windows[0]?.resetsAt).toBeGreaterThan(Date.now());
});
