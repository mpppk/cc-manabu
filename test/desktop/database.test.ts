import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Result } from "@praha/byethrow";
import initSqlJs from "sql.js";
import { createChatRepository } from "../../src/db/chat-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import { MIGRATIONS } from "../../src/db/migrate.ts";
import {
  createDatabasePersister,
  openDesktopDatabase,
  toRollbackJournal,
} from "../../src/desktop/database.ts";
import { applyWal } from "../../src/desktop/wal.ts";

const SQL = await initSqlJs();
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("openDesktopDatabase", () => {
  test("空の DB にマイグレーションを当て、CLI 版と同じリポジトリで読み書きできる", () => {
    const { db, migrated } = openDesktopDatabase(SQL);
    expect(migrated).toEqual(MIGRATIONS.map((m) => m.name));
    const chats = createChatRepository(db);
    const created = chats.createChat({ title: "テスト", cwd: "/work" });
    expect(Result.isSuccess(created)).toBe(true);
    const listed = chats.listChats();
    expect(
      Result.isSuccess(listed) && listed.value.map((c) => c.title),
    ).toEqual(["テスト"]);
  });

  test("書き出したバイト列から開き直すとデータが残り、マイグレーションは当て直さない", () => {
    const first = openDesktopDatabase(SQL);
    createChatRepository(first.db).createChat({ title: "残る", cwd: "/work" });
    const reopened = openDesktopDatabase(SQL, first.sqlite.export());
    expect(reopened.migrated).toEqual([]);
    const listed = createChatRepository(reopened.db).listChats();
    expect(Result.isSuccess(listed) && listed.value[0]?.title).toBe("残る");
  });

  test("CLI 版（bun:sqlite、WAL モード）の DB を、WAL に残ったデータごと取り込める", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cc-manabu-desktop-db-"));
    dirs.push(dir);
    const file = path.join(dir, "db.sqlite");
    const opened = openDatabase(file);
    if (Result.isFailure(opened)) throw opened.error;
    const chats = createChatRepository(opened.value.db);
    chats.createChat({ title: "CLI の会話 1", cwd: "/work" });
    chats.createChat({ title: "CLI の会話 2", cwd: "/work" });
    // 閉じてもチェックポイントされず、データは WAL に残る（CLI 版の実際の状態）
    opened.value.sqlite.close();
    const main = await Bun.file(file).bytes();
    const wal = await Bun.file(`${file}-wal`).bytes();
    expect(main[18]).toBe(2);
    expect(toRollbackJournal(main)[18]).toBe(1);

    const withoutWal = createChatRepository(
      openDesktopDatabase(SQL, main).db,
    ).listChats();
    expect(Result.isSuccess(withoutWal) && withoutWal.value).toEqual([]);

    const merged = applyWal(main, wal);
    expect(merged.frames).toBeGreaterThan(0);
    const listed = createChatRepository(
      openDesktopDatabase(SQL, merged.bytes).db,
    ).listChats();
    expect(
      Result.isSuccess(listed) && listed.value.map((c) => c.title).sort(),
    ).toEqual(["CLI の会話 1", "CLI の会話 2"]);
  });

  test("壊れた・空の WAL は無視して本体を使う", () => {
    const { sqlite } = openDesktopDatabase(SQL);
    const main = sqlite.export();
    expect(applyWal(main, new Uint8Array()).bytes).toBe(main);
    expect(applyWal(main, new Uint8Array(64).fill(7)).bytes).toBe(main);
  });
});

describe("createDatabasePersister", () => {
  test("変更があったときだけ書き出し、書き出した後も外部キーが有効", async () => {
    const { db, sqlite } = openDesktopDatabase(SQL);
    const saved: Uint8Array[] = [];
    const persister = createDatabasePersister({
      sqlite,
      save: async (bytes) => {
        saved.push(bytes);
      },
      intervalMs: 60_000,
    });
    await persister.flush();
    expect(saved).toHaveLength(0);

    createChatRepository(db).createChat({ title: "保存する", cwd: "/work" });
    await persister.flush();
    expect(saved).toHaveLength(1);
    await persister.flush();
    expect(saved).toHaveLength(1);

    const foreignKeys = sqlite.exec("PRAGMA foreign_keys")[0]?.values[0]?.[0];
    expect(foreignKeys).toBe(1);
    const restored = openDesktopDatabase(SQL, saved[0]);
    const listed = createChatRepository(restored.db).listChats();
    expect(Result.isSuccess(listed) && listed.value[0]?.title).toBe("保存する");
    persister.stop();
  });

  test("保存に失敗したら次の flush で書き直す", async () => {
    const { db, sqlite } = openDesktopDatabase(SQL);
    let fail = true;
    const saved: Uint8Array[] = [];
    const errors: unknown[] = [];
    const persister = createDatabasePersister({
      sqlite,
      save: async (bytes) => {
        if (fail) throw new Error("disk full");
        saved.push(bytes);
      },
      onError: (error) => errors.push(error),
      intervalMs: 60_000,
    });
    createChatRepository(db).createChat({ title: "x", cwd: "/work" });
    await persister.flush();
    expect(errors).toHaveLength(1);
    fail = false;
    await persister.flush();
    expect(saved).toHaveLength(1);
    persister.stop();
  });
});
