import type { Database } from "bun:sqlite";
import init from "./migrations/0000_init.sql" with { type: "text" };
import projects from "./migrations/0001_projects.sql" with { type: "text" };
import wiki from "./migrations/0002_wiki.sql" with { type: "text" };
import autoTerms from "./migrations/0003_auto_terms.sql" with { type: "text" };
import projectLinks from "./migrations/0004_project_links.sql" with {
  type: "text",
};
import projectProgress from "./migrations/0005_project_progress.sql" with {
  type: "text",
};
import branches from "./migrations/0006_branches.sql" with { type: "text" };
import queue from "./migrations/0007_queue.sql" with { type: "text" };
import appState from "./migrations/0008_app_state.sql" with { type: "text" };
import sharedWikis from "./migrations/0009_shared_wikis.sql" with {
  type: "text",
};

import wikiPageChats from "./migrations/0010_wiki_page_chats.sql" with {
  type: "text",
};
import tasks from "./migrations/0011_tasks.sql" with { type: "text" };
import environments from "./migrations/0012_environments.sql" with {
  type: "text",
};
import environmentDescription from "./migrations/0013_environment_description.sql" with {
  type: "text",
};
import wikiPageQas from "./migrations/0014_wiki_page_qas.sql" with {
  type: "text",
};

/**
 * 適用するマイグレーション。drizzle-kit generate で SQL を作ったら、ここに追記する。
 * SQL はバイナリに埋め込む（実行時に drizzle-kit は使わない）。
 */
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
  { name: "0000_init", sql: init },
  { name: "0001_projects", sql: projects },
  { name: "0002_wiki", sql: wiki },
  { name: "0003_auto_terms", sql: autoTerms },
  { name: "0004_project_links", sql: projectLinks },
  { name: "0005_project_progress", sql: projectProgress },
  { name: "0006_branches", sql: branches },
  { name: "0007_queue", sql: queue },
  { name: "0008_app_state", sql: appState },
  { name: "0009_shared_wikis", sql: sharedWikis },
  { name: "0010_wiki_page_chats", sql: wikiPageChats },
  { name: "0011_tasks", sql: tasks },
  { name: "0012_environments", sql: environments },
  { name: "0013_environment_description", sql: environmentDescription },
  { name: "0014_wiki_page_qas", sql: wikiPageQas },
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
