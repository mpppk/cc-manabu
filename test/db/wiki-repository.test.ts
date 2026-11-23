import { beforeEach, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import { openDatabase } from "../../src/db/index.ts";
import {
  createProjectRepository,
  type ProjectRepository,
} from "../../src/db/project-repository.ts";
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
      projectId: a.id,
      title: "関係タプル",
      aliases: ["relation tuple"],
      body: "# 関係タプル\n本文",
    }),
  );
  unwrap(
    wiki.createPage({
      projectId: a.id,
      title: "OpenFGA",
      aliases: [],
      body: "",
    }),
  );
  unwrap(
    wiki.createPage({ projectId: b.id, title: "別", aliases: [], body: "" }),
  );

  expect(unwrap(wiki.listPages(a.id)).map((p) => p.title)).toEqual([
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
      projectId: project.id,
      title: "t",
      aliases: [],
      body: "",
    }),
  );
  unwrap(projects.deleteProject(project.id));
  expect(unwrap(wiki.listPages(project.id))).toEqual([]);
});
