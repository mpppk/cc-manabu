import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { asc, eq } from "drizzle-orm";
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

/** プロジェクトの Wiki ページの永続化。 */
export const createWikiRepository = (db: Db) => ({
  /** プロジェクトのページ（タイトル順）。 */
  listPages: (projectId: string): Result.Result<WikiPageRow[], DatabaseError> =>
    run(() =>
      db
        .select()
        .from(wikiPages)
        .where(eq(wikiPages.projectId, projectId))
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
    input: WikiPageInput & { projectId: string; id?: string },
  ): Result.Result<WikiPageRow, DatabaseError> =>
    run(() => {
      const now = new Date();
      return db
        .insert(wikiPages)
        .values({
          id: input.id ?? crypto.randomUUID(),
          projectId: input.projectId,
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
