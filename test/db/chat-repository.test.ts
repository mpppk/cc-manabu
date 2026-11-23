import { beforeEach, describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import {
  type ChatRepository,
  createChatRepository,
} from "../../src/db/chat-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { resolveDbPath } from "../../src/db/path.ts";

const unwrap = <T>(result: Result.Result<T, unknown>): T => {
  if (Result.isFailure(result)) {
    throw result.error;
  }
  return result.value;
};

let repo: ChatRepository;

beforeEach(() => {
  const { db } = unwrap(openDatabase(":memory:"));
  repo = createChatRepository(db);
});

describe("resolveDbPath", () => {
  test("CC_MANABU_DB を優先する", () => {
    expect(resolveDbPath({ CC_MANABU_DB: "/x/db.sqlite", HOME: "/h" })).toBe(
      "/x/db.sqlite",
    );
  });
  test("XDG_DATA_HOME（絶対パスのみ）", () => {
    expect(resolveDbPath({ XDG_DATA_HOME: "/data", HOME: "/h" })).toBe(
      "/data/cc-manabu/db.sqlite",
    );
    expect(resolveDbPath({ XDG_DATA_HOME: "rel", HOME: "/h" })).toBe(
      "/h/.local/share/cc-manabu/db.sqlite",
    );
  });
});

describe("migrations", () => {
  test("2 回目は何も適用しない", () => {
    const { sqlite } = unwrap(openDatabase(":memory:"));
    expect(runMigrations(sqlite)).toEqual([]);
  });
});

describe("chats", () => {
  test("作成・一覧・名前変更・削除", () => {
    const a = unwrap(repo.createChat({ cwd: "/work" }));
    expect(a).toMatchObject({
      cwd: "/work",
      model: "default",
      status: "idle",
      title: "",
      sessionId: null,
    });
    const b = unwrap(repo.createChat({ cwd: "/work", model: "sonnet" }));
    unwrap(repo.updateChat(a.id, { title: "最初の会話" }));
    // 更新した a が先頭に来る
    expect(unwrap(repo.listChats()).map((c) => c.id)).toEqual([a.id, b.id]);
    expect(unwrap(repo.deleteChat(b.id)).id).toBe(b.id);
    expect(unwrap(repo.listChats()).map((c) => c.title)).toEqual([
      "最初の会話",
    ]);
  });

  test("存在しない会話は ChatNotFoundError", () => {
    for (const result of [
      repo.getChat("missing"),
      repo.updateChat("missing", { title: "x" }),
      repo.deleteChat("missing"),
    ]) {
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.error.name).toBe("ChatNotFoundError");
      }
    }
  });

  test("セッション ID と状態を更新できる", () => {
    const chat = unwrap(repo.createChat({ cwd: "/work" }));
    unwrap(repo.updateChat(chat.id, { sessionId: "s1" }));
    unwrap(repo.setStatus(chat.id, "running"));
    expect(unwrap(repo.getChat(chat.id)).chat).toMatchObject({
      sessionId: "s1",
      status: "running",
    });
  });
});

describe("messages", () => {
  test("順番に追加され、同じ id なら更新する", () => {
    const chat = unwrap(repo.createChat({ cwd: "/work" }));
    unwrap(
      repo.saveMessage(chat.id, {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      }),
    );
    unwrap(
      repo.saveMessage(chat.id, { id: "a1", role: "assistant", parts: [] }),
    );
    unwrap(
      repo.saveMessage(chat.id, {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }],
        metadata: { costUsd: 0.01 },
        sdkUuid: "uuid-1",
      }),
    );
    const { messages } = unwrap(repo.getChat(chat.id));
    expect(messages.map((m) => [m.id, m.seq])).toEqual([
      ["u1", 0],
      ["a1", 1],
    ]);
    expect(messages[1]).toMatchObject({
      parts: [{ type: "text", text: "hello" }],
      metadata: { costUsd: 0.01 },
      sdkUuid: "uuid-1",
    });
  });

  test("指定した seq 以降を消せる", () => {
    const chat = unwrap(repo.createChat({ cwd: "/work" }));
    for (const id of ["u1", "a1", "u2", "a2"]) {
      unwrap(
        repo.saveMessage(chat.id, {
          id,
          role: id.startsWith("u") ? "user" : "assistant",
          parts: [],
        }),
      );
    }
    expect(unwrap(repo.deleteMessagesFrom(chat.id, 2))).toBe(2);
    expect(unwrap(repo.getChat(chat.id)).messages.map((m) => m.id)).toEqual([
      "u1",
      "a1",
    ]);
    // 消したあとに追加すると seq は詰めて振られる
    unwrap(repo.saveMessage(chat.id, { id: "u3", role: "user", parts: [] }));
    expect(unwrap(repo.getChat(chat.id)).messages.at(-1)?.seq).toBe(2);
  });

  test("会話を消すとメッセージも消える", () => {
    const { db, sqlite } = unwrap(openDatabase(":memory:"));
    const r = createChatRepository(db);
    const chat = unwrap(r.createChat({ cwd: "/work" }));
    unwrap(r.saveMessage(chat.id, { id: "u1", role: "user", parts: [] }));
    unwrap(r.deleteChat(chat.id));
    expect(sqlite.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({
      n: 0,
    });
  });
});
