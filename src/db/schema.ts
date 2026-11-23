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

export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(),
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
  (table) => [index("chats_updated_at_idx").on(table.updatedAt)],
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

export type ChatRow = typeof chats.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
