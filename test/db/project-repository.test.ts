import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  type ChatRepository,
  createChatRepository,
} from "../../src/db/chat-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import { MIGRATIONS, runMigrations } from "../../src/db/migrate.ts";
import {
  createProjectRepository,
  type ProjectRepository,
} from "../../src/db/project-repository.ts";
import * as schema from "../../src/db/schema.ts";

const unwrap = <T>(result: Result.Result<T, unknown>): T => {
  if (Result.isFailure(result)) {
    throw result.error;
  }
  return result.value;
};

let projects: ProjectRepository;
let chats: ChatRepository;

beforeEach(() => {
  const { db } = unwrap(openDatabase(":memory:"));
  projects = createProjectRepository(db);
  chats = createChatRepository(db);
});

describe("projects", () => {
  test("作成・一覧（作った順）・名前変更", async () => {
    const a = unwrap(projects.createProject({ name: "認可基盤" }));
    await Bun.sleep(5);
    const b = unwrap(projects.createProject({ name: "家計簿" }));
    expect(unwrap(projects.listProjects()).map((p) => p.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect(unwrap(projects.renameProject(a.id, "認可")).name).toBe("認可");
    expect(unwrap(projects.getProject(a.id)).name).toBe("認可");
  });

  test("存在しないプロジェクトは ProjectNotFoundError", () => {
    for (const result of [
      projects.getProject("missing"),
      projects.renameProject("missing", "x"),
      projects.deleteProject("missing"),
    ]) {
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.error.name).toBe("ProjectNotFoundError");
      }
    }
  });

  test("プロジェクトに会話を作り、所属を変えられる（更新日時は動かさない）", () => {
    const project = unwrap(projects.createProject({ name: "p" }));
    const inProject = unwrap(
      chats.createChat({ cwd: "/w", projectId: project.id }),
    );
    expect(inProject.projectId).toBe(project.id);

    const loose = unwrap(chats.createChat({ cwd: "/w" }));
    expect(loose.projectId).toBeNull();
    const moved = unwrap(chats.setProject(loose.id, project.id));
    expect(moved.projectId).toBe(project.id);
    expect(moved.updatedAt).toEqual(loose.updatedAt);
    expect(unwrap(chats.setProject(loose.id, null)).projectId).toBeNull();
  });

  test("プロジェクトを消しても会話は残り、未所属に戻る", () => {
    const project = unwrap(projects.createProject({ name: "p" }));
    const chat = unwrap(chats.createChat({ cwd: "/w", projectId: project.id }));
    unwrap(projects.deleteProject(project.id));
    expect(unwrap(chats.getChat(chat.id)).chat.projectId).toBeNull();
  });

  test("存在しないプロジェクトには所属させられない", () => {
    const chat = unwrap(chats.createChat({ cwd: "/w" }));
    expect(Result.isFailure(chats.setProject(chat.id, "missing"))).toBe(true);
  });
});

describe("migration 0001_projects", () => {
  test("既存の会話とメッセージは未所属のまま残る", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    const [init] = MIGRATIONS;
    if (init === undefined) throw new Error("no migrations");
    runMigrations(sqlite, [init]);
    sqlite.exec(
      "INSERT INTO chats (id, title, cwd, session_id) VALUES ('c1', '既存', '/w', 's1')",
    );
    sqlite.exec(
      `INSERT INTO messages (id, chat_id, seq, role, parts) VALUES ('m1', 'c1', 0, 'user', '[{"type":"text","text":"hi"}]')`,
    );

    expect(runMigrations(sqlite)).toEqual(
      MIGRATIONS.slice(1).map((m) => m.name),
    );
    expect(runMigrations(sqlite)).toEqual([]);
    const repo = createChatRepository(drizzle(sqlite, { schema }));
    const { chat, messages } = unwrap(repo.getChat("c1"));
    expect(chat).toMatchObject({
      title: "既存",
      sessionId: "s1",
      projectId: null,
    });
    expect(messages.map((m) => m.id)).toEqual(["m1"]);
  });
});
