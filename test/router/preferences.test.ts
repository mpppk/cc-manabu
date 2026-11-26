import { expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { router } from "../../src/router.ts";
import { createScriptedQuery } from "../e2e/scripted-query.ts";
import { createTestContext } from "../helpers/context.ts";

test("最後に選んだモデルと effort を保存し、上書きする（#164）", async () => {
  const { context } = createTestContext({ query: createScriptedQuery() });
  const client = createRouterClient(router, { context });
  expect(await client.preferences.chatDefaults()).toBeNull();

  await client.preferences.setChatDefaults({ model: "opus", effort: "high" });
  expect(await client.preferences.chatDefaults()).toEqual({
    model: "opus",
    effort: "high",
  });

  await client.preferences.setChatDefaults({ model: "haiku", effort: null });
  expect(await client.preferences.chatDefaults()).toEqual({
    model: "haiku",
    effort: null,
  });
});

test("不正な effort は保存しない", async () => {
  const { context } = createTestContext({ query: createScriptedQuery() });
  const client = createRouterClient(router, { context });
  await expect(
    client.preferences.setChatDefaults({
      model: "opus",
      effort: "extreme" as "high",
    }),
  ).rejects.toThrow();
  expect(await client.preferences.chatDefaults()).toBeNull();
});
