import { expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import { openDatabase } from "../../src/db/index.ts";
import {
  createTaskRepository,
  requireWikiId,
} from "../../src/db/task-repository.ts";
import { createWikiHistoryRepository } from "../../src/db/wiki-history-repository.ts";
import { createWikiRepository } from "../../src/db/wiki-repository.ts";
import { createWikiToolHandlers } from "../../src/wiki/tools.ts";

const unwrap = <T>(result: Result.Result<T, unknown>): T => {
  if (Result.isFailure(result)) throw result.error;
  return result.value;
};

/** 環境の Wiki（テストのタスクは Wiki のある環境に作る）。 */
const wikiIdOf = (task: Parameters<typeof requireWikiId>[0]): string =>
  unwrap(requireWikiId(task));

test("Claude の書き込みは出どころ付きの版になり、回答で最初の書き込みの前にチェックポイントを作る（#166）", () => {
  const { db } = unwrap(openDatabase(":memory:"));
  const tasks = createTaskRepository(db);
  const wiki = createWikiRepository(db);
  const history = createWikiHistoryRepository(db);
  const task = unwrap(tasks.createTask({ name: "t" }));
  const existing = unwrap(
    wiki.createPage({
      wikiId: wikiIdOf(task),
      title: "既存",
      aliases: [],
      body: "古い本文",
    }),
  );
  const handlers = createWikiToolHandlers(
    { wiki, tasks, history },
    {
      taskId: task.id,
      chatId: "chat-1",
      batchId: "run-1",
      question: "ページを整理して",
    },
  );
  unwrap(handlers.createPage({ title: "新規", body: "本文" }));
  unwrap(
    handlers.editPage({
      id: existing.id,
      old_string: "古い",
      new_string: "新しい",
    }),
  );

  const versions = unwrap(history.listPageVersions(existing.id));
  expect(versions[0]).toMatchObject({
    actor: "claude",
    tool: "edit_page",
    chatId: "chat-1",
    batchId: "run-1",
    body: "新しい本文",
  });
  const checkpoints = unwrap(history.listCheckpoints(wikiIdOf(task)));
  expect(checkpoints.map((cp) => [cp.name, cp.auto])).toEqual([
    ["Claude の回答の前（ページを整理して）", true],
  ]);

  // チェックポイントに戻すと、回答の前の状態になる
  unwrap(history.restoreCheckpoint(checkpoints[0]?.id ?? ""));
  expect(unwrap(wiki.listPages(wikiIdOf(task))).map((p) => p.body)).toEqual([
    "古い本文",
  ]);
});
