import { Result } from "@praha/byethrow";
import { sql } from "drizzle-orm";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";

/** 検索で一致した発言（#115）。 */
export type MessageHit = {
  chatId: string;
  groupId: string;
  messageId: string;
  role: "user" | "assistant";
  snippet: Snippet;
};

/** 一致した会話タイトル。 */
export type TitleHit = { chatId: string; groupId: string; title: string };

/** 一致箇所の前後を切り出した抜粋。 */
export type Snippet = { before: string; match: string; after: string };

/** SQLite の lower() と同じく、英字（ASCII）だけ小文字にする。長さは変わらない。 */
const asciiLower = (text: string) =>
  text.replace(/[A-Z]/g, (c) => c.toLowerCase());

const SNIPPET_CONTEXT = 40;

/** 本文から一致箇所の前後を切り出す。改行は空白にする。 */
export const makeSnippet = (text: string, query: string): Snippet => {
  const flat = text.replace(/\s+/g, " ");
  const index = asciiLower(flat).indexOf(asciiLower(query));
  if (index < 0) {
    return { before: "", match: "", after: flat.slice(0, SNIPPET_CONTEXT * 2) };
  }
  const start = Math.max(0, index - SNIPPET_CONTEXT);
  const end = Math.min(flat.length, index + query.length + SNIPPET_CONTEXT);
  return {
    before: `${start > 0 ? "…" : ""}${flat.slice(start, index)}`,
    match: flat.slice(index, index + query.length),
    after: `${flat.slice(index + query.length, end)}${end < flat.length ? "…" : ""}`,
  };
};

/** 保存した会話の検索（#115）。 */
export const createSearchRepository = (db: Db) => ({
  /**
   * 会話タイトルと、発言のテキストを部分一致で探す（英字の大文字・小文字は区別しない）。
   * 分岐した会話が引き継いだ発言（分岐元の写し）は除く。発言は新しい順。
   */
  search: (
    query: string,
    limit = 100,
  ): Result.Result<
    { titles: TitleHit[]; messages: MessageHit[] },
    DatabaseError
  > =>
    Result.try({
      try: () => {
        const titles = db.all<TitleHit>(sql`
          SELECT id AS chatId, group_id AS groupId, title
          FROM chats
          WHERE title <> '' AND instr(lower(title), lower(${query})) > 0
          ORDER BY updated_at DESC
        `);
        const rows = db.all<{
          chatId: string;
          groupId: string;
          messageId: string;
          role: "user" | "assistant";
          text: string;
        }>(sql`
          WITH ordered AS (
            SELECT
              id, chat_id, role, parts, created_at,
              ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY seq) - 1 AS idx
            FROM messages
          )
          SELECT
            o.chat_id AS chatId,
            c.group_id AS groupId,
            o.id AS messageId,
            o.role AS role,
            json_extract(p.value, '$.text') AS text
          FROM ordered o
          JOIN chats c ON c.id = o.chat_id
          JOIN json_each(o.parts) p
          WHERE o.idx >= c.inherited_count
            AND json_extract(p.value, '$.type') = 'text'
            AND instr(lower(json_extract(p.value, '$.text')), lower(${query})) > 0
          ORDER BY o.created_at DESC, o.id
          LIMIT ${limit * 2}
        `);
        const seen = new Set<string>();
        const messages: MessageHit[] = [];
        for (const row of rows) {
          if (seen.has(row.messageId)) continue;
          seen.add(row.messageId);
          messages.push({
            chatId: row.chatId,
            groupId: row.groupId,
            messageId: row.messageId,
            role: row.role,
            snippet: makeSnippet(row.text, query),
          });
          if (messages.length >= limit) break;
        }
        return { titles, messages };
      },
      catch: (cause) => new DatabaseError({ cause }),
    }),
});

export type SearchRepository = ReturnType<typeof createSearchRepository>;
