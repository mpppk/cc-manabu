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
import * as schema from "../../src/db/schema.ts";
import {
  createTaskRepository,
  type TaskRepository,
} from "../../src/db/task-repository.ts";

const unwrap = <T>(result: Result.Result<T, unknown>): T => {
  if (Result.isFailure(result)) {
    throw result.error;
  }
  return result.value;
};

let tasks: TaskRepository;
let chats: ChatRepository;

beforeEach(() => {
  const { db } = unwrap(openDatabase(":memory:"));
  tasks = createTaskRepository(db);
  chats = createChatRepository(db);
});

describe("tasks", () => {
  test("作成・一覧（作った順）・名前変更", async () => {
    const a = unwrap(tasks.createTask({ name: "認可基盤" }));
    await Bun.sleep(5);
    const b = unwrap(tasks.createTask({ name: "家計簿" }));
    expect(unwrap(tasks.listTasks()).map((p) => p.id)).toEqual([a.id, b.id]);
    expect(unwrap(tasks.renameTask(a.id, "認可")).name).toBe("認可");
    expect(unwrap(tasks.getTask(a.id)).name).toBe("認可");
  });

  test("存在しないタスクは TaskNotFoundError", () => {
    for (const result of [
      tasks.getTask("missing"),
      tasks.renameTask("missing", "x"),
      tasks.deleteTask("missing"),
    ]) {
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.error.name).toBe("TaskNotFoundError");
      }
    }
  });

  test("タスクに会話を作り、所属を変えられる（更新日時は動かさない）", () => {
    const task = unwrap(tasks.createTask({ name: "p" }));
    const inTask = unwrap(chats.createChat({ cwd: "/w", taskId: task.id }));
    expect(inTask.taskId).toBe(task.id);

    const loose = unwrap(chats.createChat({ cwd: "/w" }));
    expect(loose.taskId).toBeNull();
    const moved = unwrap(chats.setTask(loose.id, task.id));
    expect(moved.taskId).toBe(task.id);
    expect(moved.updatedAt).toEqual(loose.updatedAt);
    expect(unwrap(chats.setTask(loose.id, null)).taskId).toBeNull();
  });

  test("タスクを消しても会話は残り、未所属に戻る", () => {
    const task = unwrap(tasks.createTask({ name: "p" }));
    const chat = unwrap(chats.createChat({ cwd: "/w", taskId: task.id }));
    unwrap(tasks.deleteTask(task.id));
    expect(unwrap(chats.getChat(chat.id)).chat.taskId).toBeNull();
  });

  test("存在しないタスクには所属させられない", () => {
    const chat = unwrap(chats.createChat({ cwd: "/w" }));
    expect(Result.isFailure(chats.setTask(chat.id, "missing"))).toBe(true);
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
      taskId: null,
    });
    expect(messages.map((m) => m.id)).toEqual(["m1"]);
  });
});
