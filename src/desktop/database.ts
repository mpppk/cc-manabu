import { drizzle } from "drizzle-orm/sql-js";
import type { Database, SqlJsStatic } from "sql.js";
import type { Db } from "../db/index.ts";
import { applyMigrations } from "../db/migrate.ts";
import * as schema from "../db/schema.ts";

/**
 * デスクトップアプリ版の DB。sql.js（WebAssembly の SQLite）でメモリ上に開き、
 * 変更があればファイル全体を書き出す。リポジトリは CLI 版と同じものを使う。
 */

/**
 * sql.js を読み込む。wasm を埋め込んだ版を使い、WebAssembly が使えない環境
 * （CSP で禁止されている場合など）では asm.js 版に切り替える。
 */
export const loadSqlJs = async (): Promise<SqlJsStatic> => {
  try {
    const mod = await import("sql.js/dist/sql-wasm-inline.js");
    return await mod.default();
  } catch (wasmError) {
    console.warn(
      "sql.js (wasm) を読み込めないため asm.js 版を使います",
      wasmError,
    );
    const mod = await import("sql.js/dist/sql-asm.js");
    return await mod.default();
  }
};

/**
 * WAL モードのファイル（CLI 版の DB）を、rollback journal モードとして読めるようにする。
 * ヘッダの 18・19 バイト目（書き込み・読み込みのファイル形式）が 2 なら 1 にする。
 */
export const toRollbackJournal = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length < 20 || (bytes[18] !== 2 && bytes[19] !== 2)) return bytes;
  const copy = bytes.slice();
  copy[18] = 1;
  copy[19] = 1;
  return copy;
};

export type DesktopDatabase = {
  db: Db;
  sqlite: Database;
  /** 開いたときに適用したマイグレーション（あれば保存が要る）。 */
  migrated: string[];
};

/** バイト列（無ければ空）から DB を開き、外部キーを有効にしてマイグレーションを適用する。 */
export const openDesktopDatabase = (
  SQL: SqlJsStatic,
  bytes?: Uint8Array,
): DesktopDatabase => {
  const sqlite = new SQL.Database(
    bytes === undefined ? undefined : toRollbackJournal(bytes),
  );
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const migrated = applyMigrations({
    exec: (sql) => sqlite.exec(sql),
    appliedNames: () =>
      (sqlite.exec("SELECT name FROM __migrations")[0]?.values ?? []).map(
        (row) => String(row[0]),
      ),
    markApplied: (name, appliedAt) => {
      sqlite.run("INSERT INTO __migrations (name, applied_at) VALUES (?, ?)", [
        name,
        appliedAt,
      ]);
    },
    transaction: (fn) => {
      sqlite.exec("BEGIN");
      try {
        fn();
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  });
  return { db: drizzle(sqlite, { schema }), sqlite, migrated };
};

const totalChanges = (sqlite: Database): number =>
  Number(sqlite.exec("SELECT total_changes()")[0]?.values[0]?.[0] ?? 0);

/**
 * 変更を見張り、あればファイルに書き出す。
 *
 * sql.js の export() は DB を開き直すので、pragma（外部キー）を設定し直し、
 * 変更数（total_changes）の基準も取り直す。
 */
export const createDatabasePersister = (params: {
  sqlite: Database;
  save: (bytes: Uint8Array) => Promise<void>;
  /** 開いた直後から保存が要るか（マイグレーションを適用した、取り込んだなど）。 */
  dirty?: boolean;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}) => {
  const { sqlite, save } = params;
  let baseline = totalChanges(sqlite);
  let dirty = params.dirty ?? false;
  let saving: Promise<void> | undefined;

  const flush = async (): Promise<void> => {
    if (saving !== undefined) {
      await saving;
    }
    if (!dirty && totalChanges(sqlite) === baseline) return;
    const bytes = sqlite.export();
    sqlite.exec("PRAGMA foreign_keys = ON;");
    baseline = totalChanges(sqlite);
    dirty = false;
    saving = save(bytes)
      .catch((error: unknown) => {
        dirty = true;
        params.onError?.(error);
      })
      .finally(() => {
        saving = undefined;
      });
    await saving;
  };

  const timer = setInterval(() => void flush(), params.intervalMs ?? 1000);
  return {
    flush,
    stop: () => clearInterval(timer),
  };
};
