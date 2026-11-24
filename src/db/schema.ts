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

/** プロジェクトの進捗の状態（#104）。 */
export const PROJECT_STATUSES = [
  "not_started",
  "in_progress",
  "on_hold",
  "done",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** 複数の会話（と、のちに Wiki）をまとめる単位。 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** 回答から用語ページを自動で作るか（回答ごとに Claude を追加で呼び出す）。 */
  autoTerms: integer("auto_terms", { mode: "boolean" }).notNull().default(true),
  /** 進捗の状態。既存のプロジェクトは未着手として扱う。 */
  status: text("status", { enum: PROJECT_STATUSES })
    .notNull()
    .default("not_started"),
  /** 進捗メモ（任意）。 */
  progressNote: text("progress_note").notNull().default(""),
  /** 次にやること（任意）。 */
  nextAction: text("next_action").notNull().default(""),
  /** 状態・進捗メモ・次にやることを最後に変えた日時。まだ変えていなければ null。 */
  progressUpdatedAt: integer("progress_updated_at", { mode: "timestamp_ms" }),
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
    /**
     * 会話（分岐のまとまり）の ID（#76）。最初の分岐（元の会話）では自分の id。
     * サイドバーには会話ごとに 1 行を出し、タイトル・プロジェクト・作業ディレクトリは会話で共有する。
     */
    groupId: text("group_id").notNull().default(""),
    /** 分岐元の分岐。元の会話では null。 */
    parentId: text("parent_id"),
    /** 分岐元で分岐点にした assistant メッセージの id。 */
    forkMessageId: text("fork_message_id"),
    /** 分岐元から引き継いだメッセージの数（これより後ろが分岐で書いたメッセージ）。 */
    inheritedCount: integer("inherited_count").notNull().default(0),
    /** 分岐の名前（最初の発言から作る）。元の会話では空。 */
    branchTitle: text("branch_title").notNull().default(""),
    /**
     * 分岐の最初の送信で resume する分岐元のセッションと、巻き戻す地点（assistant uuid）。
     * 送信して自分のセッション（sessionId）ができるまで使う。
     */
    forkSessionId: text("fork_session_id"),
    forkFromUuid: text("fork_from_uuid"),
    /** 最後にこの分岐を開いた日時（会話を開き直したときに表示する分岐）。 */
    lastSelectedAt: integer("last_selected_at", { mode: "timestamp_ms" }),
    /** 予約したメッセージの送信を止めているか（停止・エラーのあと。#102）。 */
    queuePaused: integer("queue_paused", { mode: "boolean" })
      .notNull()
      .default(false),
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
    index("chats_group_id_idx").on(table.groupId),
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

export const QUEUE_STATUSES = ["pending", "sending", "held"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/**
 * 生成中に予約したメッセージ（#102）。分岐（chats の行）ごとに、追加した順に 1 件ずつ送る。
 * 送るときは id をそのまま発話の id にするので、送信済みかどうかを発話の有無で確かめられる。
 */
export const queuedMessages = sqliteTable(
  "queued_messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    /** 送る順番。 */
    position: integer("position").notNull(),
    /** 送る発話の parts（JSON）。 */
    parts: text("parts", { mode: "json" }).notNull().$type<unknown[]>(),
    /**
     * pending: 送信待ち / sending: 送信中 /
     * held: 送信済みか分からない（サーバ再起動時の送信中など）。利用者に確かめてもらう
     */
    status: text("status", { enum: QUEUE_STATUSES })
      .notNull()
      .default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [index("queued_messages_chat_id_idx").on(table.chatId)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type QueuedMessageRow = typeof queuedMessages.$inferSelect;
export type ProjectLinkRow = typeof projectLinks.$inferSelect;
export type WikiPageRow = typeof wikiPages.$inferSelect;
export type ChatRow = typeof chats.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

/**
 * アプリ全体で 1 つだけ持つ値（キーごとに JSON）。
 * - `rate_limit`: 最後に観測した利用枠（#116）
 */
export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull().$type<unknown>(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
