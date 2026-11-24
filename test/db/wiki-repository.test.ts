import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openDatabase } from "../../src/db/index.ts";
import { MIGRATIONS, runMigrations } from "../../src/db/migrate.ts";
import {
  createProjectRepository,
  type ProjectRepository,
  wikiIdOf,
} from "../../src/db/project-repository.ts";
import * as schema from "../../src/db/schema.ts";
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

let projects: ProjectRepository;
let wiki: WikiRepository;

beforeEach(() => {
  const { db } = unwrap(openDatabase(":memory:"));
  projects = createProjectRepository(db);
  wiki = createWikiRepository(db);
});

test("ページの作成・一覧（タイトル順、プロジェクトごと）・更新・削除", () => {
  const a = unwrap(projects.createProject({ name: "a" }));
  const b = unwrap(projects.createProject({ name: "b" }));
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

test("プロジェクトを消すとページも消える", () => {
  const project = unwrap(projects.createProject({ name: "p" }));
  unwrap(
    wiki.createPage({
      wikiId: wikiIdOf(project),
      title: "t",
      aliases: [],
      body: "",
    }),
  );
  unwrap(projects.deleteProject(project.id));
  expect(unwrap(wiki.listPages(wikiIdOf(project)))).toEqual([]);
});

test("既存の Wiki を共有してプロジェクトを作り、最後のプロジェクトを消すまで Wiki は残る", () => {
  const a = unwrap(projects.createProject({ name: "a" }));
  const b = unwrap(projects.createProject({ name: "b", wikiId: wikiIdOf(a) }));
  expect(wikiIdOf(b)).toBe(wikiIdOf(a));
  unwrap(
    wiki.createPage({
      wikiId: wikiIdOf(b),
      title: "共有ページ",
      aliases: [],
      body: "",
    }),
  );
  expect(unwrap(projects.listWikis())).toMatchObject([
    { id: wikiIdOf(a), name: "a", projectCount: 2 },
  ]);

  unwrap(projects.deleteProject(a.id));
  expect(unwrap(wiki.listPages(wikiIdOf(b))).map((p) => p.title)).toEqual([
    "共有ページ",
  ]);
  unwrap(projects.deleteProject(b.id));
  expect(unwrap(projects.listWikis())).toEqual([]);
  expect(unwrap(wiki.listPages(wikiIdOf(b)))).toEqual([]);
});

test("無い Wiki を指定するとプロジェクトを作らない", () => {
  const result = projects.createProject({ name: "x", wikiId: "missing" });
  expect(Result.isFailure(result)).toBe(true);
  expect(unwrap(projects.listProjects())).toEqual([]);
});

test("Wiki の名前を変えられる", () => {
  const a = unwrap(projects.createProject({ name: "a" }));
  unwrap(projects.renameWiki(wikiIdOf(a), "共通用語集"));
  expect(unwrap(projects.listWikis())[0]?.name).toBe("共通用語集");
});

test("移行: 既存のプロジェクトはそれぞれ同じ ID・名前の Wiki を持ち、ページと会話の所属は残る", () => {
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

  expect(runMigrations(sqlite)).toEqual(["0009_shared_wikis"]);
  const db = drizzle(sqlite, { schema });
  const repoProjects = createProjectRepository(db);
  const repoWiki = createWikiRepository(db);
  const project = unwrap(repoProjects.getProject("p1"));
  expect(project.wikiId).toBe("p1");
  expect(unwrap(repoProjects.listWikis())).toMatchObject([
    { id: "p1", name: "認可基盤", projectCount: 1 },
  ]);
  expect(unwrap(repoWiki.listPages("p1"))).toMatchObject([
    { id: "w1", title: "関係タプル", origin: "auto", sourceChatId: "c1" },
  ]);
  expect(
    sqlite.query("SELECT project_id FROM chats WHERE id = 'c1'").get(),
  ).toEqual({ project_id: "p1" });
});
