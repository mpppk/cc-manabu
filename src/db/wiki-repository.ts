import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { and, asc, eq } from "drizzle-orm";
import { normalizeTerm, type TermCandidate } from "../wiki/terms.ts";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";
import {
  type WikiPageQaRow,
  type WikiPageRow,
  wikiPageQas,
  wikiPages,
} from "./schema.ts";
import {
  recordVersion,
  USER_CHANGE,
  type WikiChange,
} from "./wiki-versions.ts";

export class WikiPageNotFoundError extends ErrorFactory({
  name: "WikiPageNotFoundError",
  message: (fields) => `Wiki page not found: ${fields.pageId}`,
  fields: ErrorFactory.fields<{ pageId: string }>(),
}) {}

const run = <T>(fn: () => T): Result.Result<T, DatabaseError> =>
  Result.try({ try: fn, catch: (cause) => new DatabaseError({ cause }) });

const requirePage = (
  row: WikiPageRow | undefined,
  pageId: string,
): Result.Result<WikiPageRow, WikiPageNotFoundError> =>
  row === undefined
    ? Result.fail(new WikiPageNotFoundError({ pageId }))
    : Result.succeed(row);

export type WikiPageInput = {
  title: string;
  aliases: string[];
  body: string;
};

/** Wiki ページの永続化。ページは Wiki（複数のタスクで共有できる）に属する。 */
export const createWikiRepository = (db: Db) => ({
  /** タスクとページの組の Q&A（作った順。#159）。 */
  listQas: (
    taskId: string,
    wikiPageId: string,
  ): Result.Result<WikiPageQaRow[], DatabaseError> =>
    run(() =>
      db
        .select()
        .from(wikiPageQas)
        .where(
          and(
            eq(wikiPageQas.taskId, taskId),
            eq(wikiPageQas.wikiPageId, wikiPageId),
          ),
        )
        .orderBy(asc(wikiPageQas.createdAt))
        .all(),
    ),

  /**
   * 回答から作った Q&A を保存する。同じ回答の Q&A がすでにあれば作らずに undefined を返す
   * （同じ応対を処理し直しても重ならない）。
   */
  saveQa: (input: {
    taskId: string;
    wikiPageId: string;
    chatId: string;
    messageId: string;
    question: string;
    answer: string;
  }): Result.Result<WikiPageQaRow | undefined, DatabaseError> =>
    run(() =>
      db
        .insert(wikiPageQas)
        .values({ id: crypto.randomUUID(), ...input, createdAt: new Date() })
        .onConflictDoNothing({ target: wikiPageQas.messageId })
        .returning()
        .get(),
    ),

  /** Wiki のページ（タイトル順）。 */
  listPages: (wikiId: string): Result.Result<WikiPageRow[], DatabaseError> =>
    run(() =>
      db
        .select()
        .from(wikiPages)
        .where(eq(wikiPages.wikiId, wikiId))
        .orderBy(asc(wikiPages.title))
        .all(),
    ),

  getPage: (
    pageId: string,
  ): Result.Result<WikiPageRow, WikiPageNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.select().from(wikiPages).where(eq(wikiPages.id, pageId)).get(),
      ),
      Result.andThen((row) => requirePage(row, pageId)),
    ),

  /** ページを作り、版を記録する（#166）。 */
  createPage: (
    input: WikiPageInput & { wikiId: string; id?: string },
    change: WikiChange = USER_CHANGE,
  ): Result.Result<WikiPageRow, DatabaseError> =>
    run(() =>
      db.transaction((tx) => {
        const now = new Date();
        const row = tx
          .insert(wikiPages)
          .values({
            id: input.id ?? crypto.randomUUID(),
            wikiId: input.wikiId,
            title: input.title,
            aliases: input.aliases,
            body: input.body,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        recordVersion(tx, {
          wikiId: row.wikiId,
          pageId: row.id,
          state: row,
          deleted: false,
          change,
          batchId: change.batchId ?? crypto.randomUUID(),
        });
        return row;
      }),
    ),

  /** ページを書き換え、版を記録する（#166）。 */
  updatePage: (
    pageId: string,
    input: WikiPageInput,
    change: WikiChange = USER_CHANGE,
  ): Result.Result<WikiPageRow, WikiPageNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.transaction((tx) => {
          const row = tx
            .update(wikiPages)
            .set({ ...input, updatedAt: new Date() })
            .where(eq(wikiPages.id, pageId))
            .returning()
            .get();
          if (row !== undefined) {
            recordVersion(tx, {
              wikiId: row.wikiId,
              pageId: row.id,
              state: row,
              deleted: false,
              change,
              batchId: change.batchId ?? crypto.randomUUID(),
            });
          }
          return row;
        }),
      ),
      Result.andThen((row) => requirePage(row, pageId)),
    ),

  /**
   * 回答から取り出した用語のページを作る。タイトルか別名がすでにある語は作らない（既存のページを使う）。
   * 照合と作成を 1 つのトランザクションで同期的に行うので、並行・再試行でも重複しない。
   * 既存のページは書き換えない。作ったページを返す。
   * source は元の回答。Wiki ページから作ったときなど、回答が無ければ null。
   */
  createTermPages: (
    wikiId: string,
    candidates: readonly TermCandidate[],
    source: { chatId: string; messageId: string } | null,
    /** 版に残す出どころ（既定は回答からの自動作成）。作ったページはまとめて 1 つの変更にする。 */
    change: WikiChange = { actor: "auto" },
  ): Result.Result<WikiPageRow[], DatabaseError> =>
    run(() =>
      db.transaction((tx) => {
        const batchId = change.batchId ?? crypto.randomUUID();
        const known = new Set(
          tx
            .select({ title: wikiPages.title, aliases: wikiPages.aliases })
            .from(wikiPages)
            .where(eq(wikiPages.wikiId, wikiId))
            .all()
            .flatMap((page) => [page.title, ...page.aliases])
            .map(normalizeTerm),
        );
        const created: WikiPageRow[] = [];
        for (const candidate of candidates) {
          const names = [candidate.term, ...candidate.aliases].map(
            normalizeTerm,
          );
          if (names.some((name) => known.has(name))) {
            continue;
          }
          const now = new Date();
          created.push(
            tx
              .insert(wikiPages)
              .values({
                id: crypto.randomUUID(),
                wikiId,
                title: candidate.term,
                aliases: candidate.aliases,
                body: candidate.summary,
                origin: "auto",
                sourceChatId: source?.chatId ?? null,
                sourceMessageId: source?.messageId ?? null,
                createdAt: now,
                updatedAt: now,
              })
              .returning()
              .get(),
          );
          const page = created.at(-1);
          if (page !== undefined) {
            recordVersion(tx, {
              wikiId,
              pageId: page.id,
              state: page,
              deleted: false,
              change: {
                ...change,
                chatId: change.chatId ?? source?.chatId ?? null,
                messageId: change.messageId ?? source?.messageId ?? null,
              },
              batchId,
            });
          }
          for (const name of names) known.add(name);
        }
        return created;
      }),
    ),

  /** ページを消し、削除の版を記録する（版から復元できる。#166）。 */
  deletePage: (
    pageId: string,
    change: WikiChange = USER_CHANGE,
  ): Result.Result<WikiPageRow, WikiPageNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.transaction((tx) => {
          const row = tx
            .delete(wikiPages)
            .where(eq(wikiPages.id, pageId))
            .returning()
            .get();
          if (row !== undefined) {
            recordVersion(tx, {
              wikiId: row.wikiId,
              pageId: row.id,
              state: row,
              deleted: true,
              change,
              batchId: change.batchId ?? crypto.randomUUID(),
            });
          }
          return row;
        }),
      ),
      Result.andThen((row) => requirePage(row, pageId)),
    ),
});

export type WikiRepository = ReturnType<typeof createWikiRepository>;
