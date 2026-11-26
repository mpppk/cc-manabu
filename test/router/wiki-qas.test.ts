import { expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { Result } from "@praha/byethrow";
import { router } from "../../src/router.ts";
import { createScriptedQuery } from "../e2e/scripted-query.ts";
import { createTestContext } from "../helpers/context.ts";

test("Q&A はタスクとページの組ごとに返し、Wiki を共有していても混ぜない（#159）", async () => {
  const { context, chats, wiki } = createTestContext({
    query: createScriptedQuery(),
  });
  const client = createRouterClient(router, { context });
  const first = await client.environments.create({
    name: "共有元",
    directories: [process.cwd()],
  });
  const second = await client.environments.create({
    name: "共有先",
    directories: [process.cwd()],
    wikiId: first.wikiId,
  });
  const taskA = await client.tasks.create({
    name: "A",
    environmentId: first.id,
  });
  const taskB = await client.tasks.create({
    name: "B",
    environmentId: second.id,
  });
  const page = await client.wiki.create({
    taskId: taskA.id,
    title: "共有ページ",
    aliases: [],
    body: "",
  });
  const other = await client.wiki.create({
    taskId: taskA.id,
    title: "別のページ",
    aliases: [],
    body: "",
  });
  const save = (taskId: string, pageId: string, question: string) => {
    const chat = chats.getOrCreateWikiChat({
      id: crypto.randomUUID(),
      taskId,
      wikiPageId: pageId,
      title: "",
      cwd: "/work",
    });
    if (Result.isFailure(chat)) throw chat.error;
    wiki.saveQa({
      taskId,
      wikiPageId: pageId,
      chatId: chat.value.id,
      messageId: crypto.randomUUID(),
      question,
      answer: "回答",
    });
  };
  save(taskA.id, page.id, "A の質問");
  save(taskB.id, page.id, "B の質問");
  save(taskA.id, other.id, "別ページの質問");

  expect(
    (await client.wiki.qas({ taskId: taskA.id, pageId: page.id })).map(
      (qa) => qa.question,
    ),
  ).toEqual(["A の質問"]);
  expect(
    (await client.wiki.qas({ taskId: taskB.id, pageId: page.id })).map(
      (qa) => qa.question,
    ),
  ).toEqual(["B の質問"]);
});
