import type { Database } from "bun:sqlite";
import init from "./migrations/0000_init.sql" with { type: "text" };
import projects from "./migrations/0001_projects.sql" with { type: "text" };
import wiki from "./migrations/0002_wiki.sql" with { type: "text" };
import autoTerms from "./migrations/0003_auto_terms.sql" with { type: "text" };

/**
 * 適用するマイグレーション。drizzle-kit generate で SQL を作ったら、ここに追記する。
 * SQL はバイナリに埋め込む（実行時に drizzle-kit は使わない）。
 */
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
  { name: "0000_init", sql: init },
  { name: "0001_projects", sql: projects },
  { name: "0002_wiki", sql: wiki },
  { name: "0003_auto_terms", sql: autoTerms },
];

/** 未適用のマイグレーションを順に適用する。 */
export const runMigrations = (
  sqlite: Database,
  migrations: readonly { name: string; sql: string }[] = MIGRATIONS,
): string[] => {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS __migrations (
    name TEXT PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    sqlite
      .query<{ name: string }, []>("SELECT name FROM __migrations")
      .all()
      .map((row) => row.name),
  );
  const newlyApplied: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      continue;
    }
    sqlite.transaction(() => {
      for (const statement of migration.sql.split("--> statement-breakpoint")) {
        if (statement.trim() !== "") {
          sqlite.exec(statement);
        }
      }
      sqlite
        .query("INSERT INTO __migrations (name, applied_at) VALUES (?, ?)")
        .run(migration.name, Date.now());
    })();
    newlyApplied.push(migration.name);
  }
  return newlyApplied;
};
