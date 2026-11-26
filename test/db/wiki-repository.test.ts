import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  createEnvironmentRepository,
  type EnvironmentRepository,
} from "../../src/db/environment-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import { MIGRATIONS, runMigrations } from "../../src/db/migrate.ts";
import * as schema from "../../src/db/schema.ts";
import {
  createTaskRepository,
  type TaskRepository,
  wikiIdOf,
} from "../../src/db/task-repository.ts";
import {
  createWikiRepository,
  type WikiRepository,
} from "../../src/db/wiki-repository.ts";

const unwrap = <T>(result: Result.Result<T, unknown>): T => {
  if (Result.isFailure(result)) {
    throw result.error;
  }
  return result.value;
};

let tasks: TaskRepository;
let environments: EnvironmentRepository;
let wiki: WikiRepository;

beforeEach(() => {
  const { db } = unwrap(openDatabase(":memory:"));
  tasks = createTaskRepository(db);
  environments = createEnvironmentRepository(db);
  wiki = createWikiRepository(db);
});

test("ページの作成・一覧（タイトル順、タスクごと）・更新・削除", () => {
  const a = unwrap(tasks.createTask({ name: "a" }));
  const b = unwrap(tasks.createTask({ name: "b" }));
  const tuple = unwrap(
    wiki.createPage({
      wikiId: wikiIdOf(a),
      title: "関係タプル",
      aliases: ["relation tuple"],
      body: "# 関係タプル\n本文",
    }),
  );
  unwrap(
    wiki.createPage({
      wikiId: wikiIdOf(a),
      title: "OpenFGA",
      aliases: [],
      body: "",
    }),
  );
  unwrap(
    wiki.createPage({
      wikiId: wikiIdOf(b),
      title: "別",
      aliases: [],
      body: "",
    }),
  );

  expect(unwrap(wiki.listPages(wikiIdOf(a))).map((p) => p.title)).toEqual([
    "OpenFGA",
    "関係タプル",
  ]);
  expect(unwrap(wiki.getPage(tuple.id)).aliases).toEqual(["relation tuple"]);

  const updated = unwrap(
    wiki.updatePage(tuple.id, {
      title: "タプル",
      aliases: [],
      body: "新しい本文",
    }),
  );
  expect(updated).toMatchObject({
    title: "タプル",
    aliases: [],
    body: "新しい本文",
  });
  expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
    tuple.updatedAt.getTime(),
  );

  unwrap(wiki.deletePage(tuple.id));
  const missing = wiki.getPage(tuple.id);
  expect(Result.isFailure(missing)).toBe(true);
  if (Result.isFailure(missing)) {
    expect(missing.error.name).toBe("WikiPageNotFoundError");
  }
});

test("タスクを消してもページは環境の Wiki に残り、環境を消すとページも消える", () => {
  const task = unwrap(tasks.createTask({ name: "p" }));
  unwrap(
    wiki.createPage({
      wikiId: wikiIdOf(task),
      title: "t",
      aliases: [],
      body: "",
    }),
  );
  unwrap(tasks.deleteTask(task.id));
  expect(unwrap(wiki.listPages(wikiIdOf(task)))).toHaveLength(1);
  unwrap(environments.deleteEnvironment(task.environmentId ?? ""));
  expect(unwrap(wiki.listPages(wikiIdOf(task)))).toEqual([]);
});

test("同じ環境のタスクは Wiki を共有し、タスクを消しても Wiki は環境に残る", () => {
  const a = unwrap(tasks.createTask({ name: "a" }));
  const b = unwrap(
    tasks.createTask({ name: "b", environmentId: a.environmentId ?? "" }),
  );
  expect(wikiIdOf(b)).toBe(wikiIdOf(a));
  unwrap(
    wiki.createPage({
      wikiId: wikiIdOf(b),
      title: "共有ページ",
      aliases: [],
      body: "",
    }),
  );
  expect(unwrap(tasks.listWikis())).toMatchObject([
    { id: wikiIdOf(a), name: "a", taskCount: 2 },
  ]);

  unwrap(tasks.deleteTask(a.id));
  expect(unwrap(wiki.listPages(wikiIdOf(b))).map((p) => p.title)).toEqual([
    "共有ページ",
  ]);
  unwrap(tasks.deleteTask(b.id));
  expect(unwrap(wiki.listPages(wikiIdOf(b))).map((p) => p.title)).toEqual([
    "共有ページ",
  ]);
});

test("無い環境を指定するとタスクを作らない", () => {
  const result = tasks.createTask({ name: "x", environmentId: "missing" });
  expect(Result.isFailure(result)).toBe(true);
  expect(unwrap(tasks.listTasks())).toEqual([]);
});

test("Wiki の名前を変えられる", () => {
  const a = unwrap(tasks.createTask({ name: "a" }));
  unwrap(tasks.renameWiki(wikiIdOf(a), "共通用語集"));
  expect(unwrap(tasks.listWikis())[0]?.name).toBe("共通用語集");
});

test("移行: 既存のタスクはそれぞれ同じ ID・名前の Wiki を持ち、ページと会話の所属は残る", () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const before = MIGRATIONS.filter((m) => m.name < "0009");
  runMigrations(sqlite, before);
  sqlite.exec("INSERT INTO projects (id, name) VALUES ('p1', '認可基盤')");
  sqlite.exec(
    "INSERT INTO chats (id, title, cwd, project_id) VALUES ('c1', '会話', '/w', 'p1')",
  );
  sqlite.exec(
    "INSERT INTO wiki_pages (id, project_id, title, origin, source_chat_id) VALUES ('w1', 'p1', '関係タプル', 'auto', 'c1')",
  );

  expect(runMigrations(sqlite)).toEqual([
    "0009_shared_wikis",
    "0010_wiki_page_chats",
    "0011_tasks",
    "0012_environments",
    "0013_environment_description",
    "0014_wiki_page_qas",
  ]);
  const db = drizzle(sqlite, { schema });
  const repoTasks = createTaskRepository(db);
  const repoWiki = createWikiRepository(db);
  const task = unwrap(repoTasks.getTask("p1"));
  expect(task.wikiId).toBe("p1");
  expect(unwrap(repoTasks.listWikis())).toMatchObject([
    { id: "p1", name: "認可基盤", taskCount: 1 },
  ]);
  expect(unwrap(repoWiki.listPages("p1"))).toMatchObject([
    { id: "w1", title: "関係タプル", origin: "auto", sourceChatId: "c1" },
  ]);
  expect(
    sqlite
      .query("SELECT task_id, wiki_page_id FROM chats WHERE id = 'c1'")
      .get(),
  ).toEqual({ task_id: "p1", wiki_page_id: null });
});
