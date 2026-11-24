import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { asc, eq } from "drizzle-orm";
import { normalizeTerm, type TermCandidate } from "../wiki/terms.ts";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";
import { type WikiPageRow, wikiPages } from "./schema.ts";

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

/** Wiki ページの永続化。ページは Wiki（複数のプロジェクトで共有できる）に属する。 */
export const createWikiRepository = (db: Db) => ({
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

  createPage: (
    input: WikiPageInput & { wikiId: string; id?: string },
  ): Result.Result<WikiPageRow, DatabaseError> =>
    run(() => {
      const now = new Date();
      return db
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
    }),

  updatePage: (
    pageId: string,
    input: WikiPageInput,
  ): Result.Result<WikiPageRow, WikiPageNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .update(wikiPages)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(wikiPages.id, pageId))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requirePage(row, pageId)),
    ),

  /**
   * 回答から取り出した用語のページを作る。タイトルか別名がすでにある語は作らない（既存のページを使う）。
   * 照合と作成を 1 つのトランザクションで同期的に行うので、並行・再試行でも重複しない。
   * 既存のページは書き換えない。作ったページを返す。
   */
  createTermPages: (
    wikiId: string,
    candidates: readonly TermCandidate[],
    source: { chatId: string; messageId: string },
  ): Result.Result<WikiPageRow[], DatabaseError> =>
    run(() =>
      db.transaction((tx) => {
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
                sourceChatId: source.chatId,
                sourceMessageId: source.messageId,
                createdAt: now,
                updatedAt: now,
              })
              .returning()
              .get(),
          );
          for (const name of names) known.add(name);
        }
        return created;
      }),
    ),

  deletePage: (
    pageId: string,
  ): Result.Result<WikiPageRow, WikiPageNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.delete(wikiPages).where(eq(wikiPages.id, pageId)).returning().get(),
      ),
      Result.andThen((row) => requirePage(row, pageId)),
    ),
});

export type WikiRepository = ReturnType<typeof createWikiRepository>;
