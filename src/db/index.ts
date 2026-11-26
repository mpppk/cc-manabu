import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { runMigrations } from "./migrate.ts";
import * as schema from "./schema.ts";

export type Db = BunSQLiteDatabase<typeof schema>;

export class DatabaseOpenError extends ErrorFactory({
  name: "DatabaseOpenError",
  message: (fields) => `Failed to open the database at ${fields.path}`,
  fields: ErrorFactory.fields<{ path: string }>(),
}) {}

/** DB を開き、WAL・外部キー・ロック待ちを有効にして、マイグレーションを適用する。`:memory:` も可。 */
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
      // monet の本体と `monet mcp`（#212）が同じ DB に書くので、ロック中は少し待つ
      sqlite.exec("PRAGMA busy_timeout = 5000;");
      runMigrations(sqlite);
      return { db: drizzle(sqlite, { schema }), sqlite };
    },
    catch: (error) => new DatabaseOpenError({ path: dbPath, cause: error }),
  });

export * from "./schema.ts";
