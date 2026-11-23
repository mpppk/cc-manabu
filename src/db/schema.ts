import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const CHAT_STATUSES = [
  "idle",
  "running",
  "awaiting_approval",
  "error",
] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];

/** 複数の会話（と、のちに Wiki）をまとめる単位。 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** 回答から用語ページを自動で作るか（回答ごとに Claude を追加で呼び出す）。 */
  autoTerms: integer("auto_terms", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
});

export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(),
    /** 所属するプロジェクト。未所属なら null。プロジェクトを消すと未所属に戻る。 */
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull().default(""),
    /** resume する Claude Code のセッション ID。最初の送信まではない。 */
    sessionId: text("session_id"),
    model: text("model").notNull().default("default"),
    effort: text("effort"),
    cwd: text("cwd").notNull(),
    status: text("status", { enum: CHAT_STATUSES }).notNull().default("idle"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    index("chats_updated_at_idx").on(table.updatedAt),
    index("chats_project_id_idx").on(table.projectId),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    /** UIMessage の id。 */
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    /** 会話内での順番（0 始まり）。 */
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    /** UIMessage の parts（JSON）。 */
    parts: text("parts", { mode: "json" }).notNull().$type<unknown[]>(),
    /** UIMessage の metadata（usage、costUsd など。JSON）。 */
    metadata: text("metadata", { mode: "json" }).$type<unknown>(),
    /**
     * assistant 行: そのターンで最後に届いた assistant メッセージの uuid。
     * 再生成・編集の分岐点に使う（docs/spikes/session-branching.md）。
     */
    sdkUuid: text("sdk_uuid"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [uniqueIndex("messages_chat_seq_idx").on(table.chatId, table.seq)],
);

/** プロジェクトの Wiki ページ（Markdown）。プロジェクトを消すと一緒に消える。 */
export const wikiPages = sqliteTable(
  "wiki_pages",
  {
    /** 安定したページ ID（回答からのリンクに使う）。 */
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** 別名（JSON の文字列配列）。関連ページの照合とリンクに使う。 */
    aliases: text("aliases", { mode: "json" })
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),
    /** Markdown の本文。 */
    body: text("body").notNull().default(""),
    /** 作られ方。auto は回答からの自動作成（#80）。 */
    origin: text("origin", { enum: ["manual", "auto"] })
      .notNull()
      .default("manual"),
    /** 自動作成の元になった会話と回答。会話を消すと null になる。 */
    sourceChatId: text("source_chat_id").references(() => chats.id, {
      onDelete: "set null",
    }),
    sourceMessageId: text("source_message_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [index("wiki_pages_project_id_idx").on(table.projectId)],
);

/** プロジェクトの関連リンク（GitHub リポジトリ・設計資料など、繰り返し開く URL）。 */
export const projectLinks = sqliteTable(
  "project_links",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** http / https の URL。 */
    url: text("url").notNull(),
    /** 表示名。無ければ URL を表示する。 */
    label: text("label"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [index("project_links_project_id_idx").on(table.projectId)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectLinkRow = typeof projectLinks.$inferSelect;
export type WikiPageRow = typeof wikiPages.$inferSelect;
export type ChatRow = typeof chats.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
