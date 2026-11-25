import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { runMigrations } from "./migrate.ts";
import * as schema from "./schema.ts";

/**
 * リポジトリが使う DB。同期の SQLite ドライバなら何でもよい
 * （CLI は bun:sqlite、デスクトップアプリ版は sql.js）。
 */
export type Db = BaseSQLiteDatabase<"sync", void, typeof schema>;

export class DatabaseOpenError extends ErrorFactory({
  name: "DatabaseOpenError",
  message: (fields) => `Failed to open the database at ${fields.path}`,
  fields: ErrorFactory.fields<{ path: string }>(),
}) {}

/** DB を開き、WAL と外部キーを有効にして、マイグレーションを適用する。`:memory:` も可。 */
export const openDatabase = (
  dbPath: string,
): Result.Result<{ db: Db; sqlite: Database }, DatabaseOpenError> =>
  Result.try({
    try: () => {
      if (dbPath !== ":memory:") {
        mkdirSync(path.dirname(dbPath), { recursive: true });
      }
      const sqlite = new Database(dbPath, { create: true, strict: true });
      sqlite.exec("PRAGMA journal_mode = WAL;");
      sqlite.exec("PRAGMA foreign_keys = ON;");
      runMigrations(sqlite);
      return { db: drizzle(sqlite, { schema }), sqlite };
    },
    catch: (error) => new DatabaseOpenError({ path: dbPath, cause: error }),
  });

export * from "./schema.ts";
