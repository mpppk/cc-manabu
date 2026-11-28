import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
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

const errorName = (
  result: Result.Result<unknown, Error>,
): string | undefined =>
  Result.isFailure(result) ? result.error.name : undefined;

let environments: EnvironmentRepository;
let tasks: TaskRepository;
let wiki: WikiRepository;

beforeEach(() => {
  const { db } = unwrap(openDatabase(":memory:"));
  environments = createEnvironmentRepository(db);
  tasks = createTaskRepository(db);
  wiki = createWikiRepository(db);
});

describe("環境", () => {
  test("作ると同じ名前の Wiki ができ、一覧に Wiki の名前とタスクの数が出る", () => {
    const env = unwrap(
      environments.createEnvironment({
        name: "cc-manabu",
        directories: ["/repo", "/docs"],
      }),
    );
    unwrap(tasks.createTask({ name: "a", environmentId: env.id }));
    unwrap(tasks.createTask({ name: "b", environmentId: env.id }));
    expect(unwrap(environments.listEnvironments())).toMatchObject([
      {
        id: env.id,
        name: "cc-manabu",
        directories: ["/repo", "/docs"],
        wikiName: "cc-manabu",
        taskCount: 2,
      },
    ]);
    expect(unwrap(environments.directoriesOfTask("missing"))).toBeUndefined();
  });

  test("既存の Wiki を共有して作れる。無い Wiki は指定できない", () => {
    const a = unwrap(
      environments.createEnvironment({ name: "a", directories: ["/a"] }),
    );
    const b = unwrap(
      environments.createEnvironment({
        name: "b",
        directories: ["/b"],
        wikiId: a.wikiId,
      }),
    );
    expect(b.wikiId).toBe(a.wikiId);
    expect(
      errorName(
        environments.createEnvironment({
          name: "c",
          directories: ["/c"],
          wikiId: "missing",
        }),
      ),
    ).toBe("WikiNotFoundError");
  });

  test("Wiki を変えると、属するタスクの Wiki も変わる", () => {
    const a = unwrap(
      environments.createEnvironment({ name: "a", directories: ["/a"] }),
    );
    const b = unwrap(
      environments.createEnvironment({ name: "b", directories: ["/b"] }),
    );
    const task = unwrap(tasks.createTask({ name: "t", environmentId: a.id }));
    expect(task.wikiId).toBe(a.wikiId);
    unwrap(environments.updateEnvironment(a.id, { wikiId: b.wikiId }));
    expect(unwrap(tasks.getTask(task.id)).wikiId).toBe(b.wikiId);
    expect(
      errorName(environments.updateEnvironment(a.id, { wikiId: "missing" })),
    ).toBe("WikiNotFoundError");
    expect(
      errorName(environments.updateEnvironment("missing", { name: "x" })),
    ).toBe("EnvironmentNotFoundError");
  });

  test("タスクを別の環境に移すと、Wiki も移った環境のものになる", () => {
    const a = unwrap(
      environments.createEnvironment({ name: "a", directories: ["/a"] }),
    );
    const b = unwrap(
      environments.createEnvironment({ name: "b", directories: ["/b", "/c"] }),
    );
    const task = unwrap(tasks.createTask({ name: "t", environmentId: a.id }));
    const moved = unwrap(tasks.setEnvironment(task.id, b.id));
    expect(moved).toMatchObject({ environmentId: b.id, wikiId: b.wikiId });
    expect(unwrap(environments.directoriesOfTask(task.id))).toEqual([
      "/b",
      "/c",
    ]);
    expect(errorName(tasks.setEnvironment(task.id, "missing"))).toBe(
      "EnvironmentNotFoundError",
    );
    expect(errorName(tasks.setEnvironment("missing", b.id))).toBe(
      "TaskNotFoundError",
    );
  });

  test("タスクがある環境は消せない。消すと、ほかで使っていない Wiki はページごと消える", () => {
    const a = unwrap(
      environments.createEnvironment({ name: "a", directories: ["/a"] }),
    );
    const shared = unwrap(
      environments.createEnvironment({
        name: "shared",
        directories: ["/s"],
        wikiId: a.wikiId,
      }),
    );
    const task = unwrap(tasks.createTask({ name: "t", environmentId: a.id }));
    const wikiId = a.wikiId ?? "";
    unwrap(wiki.createPage({ wikiId, title: "p", aliases: [], body: "" }));
    expect(errorName(environments.deleteEnvironment(a.id))).toBe(
      "EnvironmentNotEmptyError",
    );

    unwrap(tasks.deleteTask(task.id));
    unwrap(environments.deleteEnvironment(a.id));
    // 共有している環境があるので、Wiki は残る
    expect(unwrap(wiki.listPages(wikiId))).toHaveLength(1);
    unwrap(environments.deleteEnvironment(shared.id));
    expect(unwrap(wiki.listPages(wikiId))).toEqual([]);
    expect(unwrap(tasks.listWikis())).toEqual([]);
    expect(errorName(environments.deleteEnvironment(a.id))).toBe(
      "EnvironmentNotFoundError",
    );
  });

  test("ディレクトリが空の環境だけを、起動したディレクトリで埋める", () => {
    const empty = unwrap(
      environments.createEnvironment({ name: "empty", directories: [] }),
    );
    const set = unwrap(
      environments.createEnvironment({ name: "set", directories: ["/repo"] }),
    );
    expect(unwrap(environments.fillEmptyDirectories("/launch"))).toBe(1);
    expect(unwrap(environments.getEnvironment(empty.id)).directories).toEqual([
      "/launch",
    ]);
    expect(unwrap(environments.getEnvironment(set.id)).directories).toEqual([
      "/repo",
    ]);
  });

  test("環境を選ばずに作ったタスクは、同じ名前の環境と Wiki を新しく作る", () => {
    const task = unwrap(
      tasks.createTask({ name: "新規", directories: ["/w"] }),
    );
    expect(unwrap(environments.listEnvironments())).toMatchObject([
      {
        id: task.environmentId,
        name: "新規",
        wikiId: task.wikiId,
        directories: ["/w"],
        taskCount: 1,
      },
    ]);
  });
});

describe("migration 0012_environments", () => {
  test("タスクが参照する Wiki ごとに環境を作り、ディレクトリは最後に使った作業ディレクトリにする", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    runMigrations(
      sqlite,
      MIGRATIONS.filter((m) => m.name < "0012"),
    );
    sqlite.exec(
      "INSERT INTO wikis (id, name) VALUES ('w1', '認可基盤'), ('w2', '家計簿')",
    );
    sqlite.exec(
      "INSERT INTO tasks (id, name, wiki_id) VALUES ('t1', '開発', 'w1'), ('t2', '運用', 'w1'), ('t3', '家計簿', 'w2')",
    );
    sqlite.exec(
      `INSERT INTO chats (id, title, cwd, task_id, updated_at) VALUES
        ('c1', '古い', '/old', 't1', 1000),
        ('c2', '新しい', '/repo', 't2', 2000),
        ('c3', '未所属', '/other', NULL, 3000)`,
    );

    expect(runMigrations(sqlite)).toEqual([
      "0012_environments",
      "0013_environment_description",
      "0014_wiki_page_qas",
      "0015_wiki_history",
      "0016_goal_runs",
      "0017_environment_without_wiki",
      "0018_task_archive",
    ]);
    const db = drizzle(sqlite, { schema });
    const repo = createEnvironmentRepository(db);
    expect(unwrap(repo.listEnvironments())).toMatchObject([
      {
        id: "w1",
        name: "認可基盤",
        wikiId: "w1",
        directories: ["/repo"],
        taskCount: 2,
      },
      {
        id: "w2",
        name: "家計簿",
        wikiId: "w2",
        directories: [],
        taskCount: 1,
      },
    ]);
    expect(
      sqlite.query("SELECT id, environment_id FROM tasks ORDER BY id").all(),
    ).toEqual([
      { id: "t1", environment_id: "w1" },
      { id: "t2", environment_id: "w1" },
      { id: "t3", environment_id: "w2" },
    ]);
    // 会話の無かった環境は、起動時に起動したディレクトリで埋める
    expect(unwrap(repo.fillEmptyDirectories("/launch"))).toBe(1);
    expect(unwrap(repo.directoriesOfTask("t3"))).toEqual(["/launch"]);
  });
});

describe("Wiki を使わない環境（#232）", () => {
  test("Wiki を作らずに作れ、タスクも Wiki を参照しない", () => {
    const env = unwrap(
      environments.createEnvironment({
        name: "scratch",
        directories: ["/s"],
        wikiId: null,
      }),
    );
    expect(env.wikiId).toBeNull();
    expect(unwrap(tasks.listWikis())).toEqual([]);
    const task = unwrap(tasks.createTask({ name: "t", environmentId: env.id }));
    expect(task.wikiId).toBeNull();
    expect(unwrap(environments.listEnvironments())).toMatchObject([
      { id: env.id, wikiId: null, wikiName: null, taskCount: 1 },
    ]);
  });

  test("あとから新しい Wiki を作って使え、使わなくしても Wiki は残る", () => {
    const env = unwrap(
      environments.createEnvironment({
        name: "scratch",
        directories: ["/s"],
        wikiId: null,
      }),
    );
    const task = unwrap(tasks.createTask({ name: "t", environmentId: env.id }));

    const withWiki = unwrap(
      environments.updateEnvironment(env.id, { newWiki: true }),
    );
    expect(withWiki.wikiId).not.toBeNull();
    expect(unwrap(tasks.getTask(task.id)).wikiId).toBe(withWiki.wikiId);
    expect(unwrap(tasks.listWikis())).toMatchObject([
      { id: withWiki.wikiId, name: "scratch", taskCount: 1 },
    ]);

    unwrap(environments.updateEnvironment(env.id, { wikiId: null }));
    expect(unwrap(tasks.getTask(task.id)).wikiId).toBeNull();
    expect(unwrap(tasks.listWikis())).toMatchObject([
      { id: withWiki.wikiId, taskCount: 0 },
    ]);
  });

  test("Wiki を使わない環境も消せる", () => {
    const env = unwrap(
      environments.createEnvironment({
        name: "scratch",
        directories: ["/s"],
        wikiId: null,
      }),
    );
    unwrap(environments.deleteEnvironment(env.id));
    expect(unwrap(environments.listEnvironments())).toEqual([]);
  });

  test("移行で環境の表を作り直しても、タスクの所属と外部キーは保たれる", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    runMigrations(
      sqlite,
      MIGRATIONS.filter((m) => m.name < "0017"),
    );
    sqlite.exec("INSERT INTO wikis (id, name) VALUES ('w1', '認可基盤')");
    sqlite.exec(
      `INSERT INTO environments (id, name, wiki_id, directories, description)
        VALUES ('e1', '認可基盤', 'w1', '["/repo"]', '説明')`,
    );
    sqlite.exec(
      "INSERT INTO tasks (id, name, environment_id, wiki_id) VALUES ('t1', '開発', 'e1', 'w1')",
    );

    expect(runMigrations(sqlite)).toEqual([
      "0017_environment_without_wiki",
      "0018_task_archive",
    ]);
    expect(
      sqlite.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get(),
    ).toEqual({ foreign_keys: 1 });
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const repo = createEnvironmentRepository(drizzle(sqlite, { schema }));
    expect(unwrap(repo.listEnvironments())).toMatchObject([
      {
        id: "e1",
        wikiId: "w1",
        wikiName: "認可基盤",
        directories: ["/repo"],
        description: "説明",
        taskCount: 1,
      },
    ]);
    // 作り直した表にも外部キーが効いている
    expect(() =>
      sqlite.exec(
        "INSERT INTO environments (id, name, wiki_id) VALUES ('e2', 'x', 'missing')",
      ),
    ).toThrow();
    expect(() =>
      sqlite.exec("DELETE FROM environments WHERE id = 'e1'"),
    ).toThrow();
    sqlite.exec(
      "INSERT INTO environments (id, name, wiki_id) VALUES ('e3', 'Wiki なし', NULL)",
    );
  });
});
