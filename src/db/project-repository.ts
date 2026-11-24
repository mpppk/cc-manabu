import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";
import {
  type ProjectLinkRow,
  type ProjectRow,
  type ProjectStatus,
  projectLinks,
  projects,
  type WikiRow,
  wikis,
} from "./schema.ts";

export class WikiNotFoundError extends ErrorFactory({
  name: "WikiNotFoundError",
  message: (fields) => `Wiki not found: ${fields.wikiId}`,
  fields: ErrorFactory.fields<{ wikiId: string }>(),
}) {}

/** プロジェクトが参照する Wiki。古い行で未設定なら、移行で作った同じ ID の Wiki。 */
export const wikiIdOf = (project: Pick<ProjectRow, "id" | "wikiId">): string =>
  project.wikiId ?? project.id;

/** Wiki と、それを参照しているプロジェクトの数。 */
export type WikiSummary = WikiRow & { projectCount: number };

export class ProjectNotFoundError extends ErrorFactory({
  name: "ProjectNotFoundError",
  message: (fields) => `Project not found: ${fields.projectId}`,
  fields: ErrorFactory.fields<{ projectId: string }>(),
}) {}

export class ProjectLinkNotFoundError extends ErrorFactory({
  name: "ProjectLinkNotFoundError",
  message: (fields) => `Project link not found: ${fields.linkId}`,
  fields: ErrorFactory.fields<{ linkId: string }>(),
}) {}

const requireLink = (
  row: ProjectLinkRow | undefined,
  linkId: string,
): Result.Result<ProjectLinkRow, ProjectLinkNotFoundError> =>
  row === undefined
    ? Result.fail(new ProjectLinkNotFoundError({ linkId }))
    : Result.succeed(row);

const run = <T>(fn: () => T): Result.Result<T, DatabaseError> =>
  Result.try({ try: fn, catch: (cause) => new DatabaseError({ cause }) });

const requireProject = (
  row: ProjectRow | undefined,
  projectId: string,
): Result.Result<ProjectRow, ProjectNotFoundError> =>
  row === undefined
    ? Result.fail(new ProjectNotFoundError({ projectId }))
    : Result.succeed(row);

/** プロジェクトの永続化。会話の所属は chats.project_id に持つ。 */
export const createProjectRepository = (db: Db) => ({
  /**
   * プロジェクトを作る。wikiId があればその Wiki を共有し、無ければ同じ名前の Wiki を新しく作る。
   */
  createProject: (input: {
    name: string;
    id?: string;
    wikiId?: string;
  }): Result.Result<ProjectRow, WikiNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.transaction((tx) => {
          const now = new Date();
          let wikiId = input.wikiId;
          if (wikiId === undefined) {
            wikiId = crypto.randomUUID();
            tx.insert(wikis)
              .values({
                id: wikiId,
                name: input.name,
                createdAt: now,
                updatedAt: now,
              })
              .run();
          } else if (
            tx
              .select({ id: wikis.id })
              .from(wikis)
              .where(eq(wikis.id, wikiId))
              .get() === undefined
          ) {
            return undefined;
          }
          return tx
            .insert(projects)
            .values({
              id: input.id ?? crypto.randomUUID(),
              name: input.name,
              wikiId,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
        }),
      ),
      Result.andThen((row) =>
        row === undefined
          ? Result.fail(new WikiNotFoundError({ wikiId: input.wikiId ?? "" }))
          : Result.succeed(row),
      ),
    ),

  /** Wiki（作った順）と、参照しているプロジェクトの数。 */
  listWikis: (): Result.Result<WikiSummary[], DatabaseError> =>
    run(() => {
      const counts = new Map(
        db
          .select({ wikiId: projects.wikiId, n: count() })
          .from(projects)
          .groupBy(projects.wikiId)
          .all()
          .map((row) => [row.wikiId, row.n]),
      );
      return db
        .select()
        .from(wikis)
        .orderBy(asc(wikis.createdAt))
        .all()
        .map((wiki) => ({ ...wiki, projectCount: counts.get(wiki.id) ?? 0 }));
    }),

  /** Wiki の名前を変える（共有しているすべてのプロジェクトに反映される）。 */
  renameWiki: (
    wikiId: string,
    name: string,
  ): Result.Result<WikiRow, WikiNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .update(wikis)
          .set({ name, updatedAt: new Date() })
          .where(eq(wikis.id, wikiId))
          .returning()
          .get(),
      ),
      Result.andThen((row) =>
        row === undefined
          ? Result.fail(new WikiNotFoundError({ wikiId }))
          : Result.succeed(row),
      ),
    ),

  /** 作った順（並びが勝手に変わらないように）。 */
  listProjects: (): Result.Result<ProjectRow[], DatabaseError> =>
    run(() =>
      db.select().from(projects).orderBy(asc(projects.createdAt)).all(),
    ),

  getProject: (
    projectId: string,
  ): Result.Result<ProjectRow, ProjectNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.select().from(projects).where(eq(projects.id, projectId)).get(),
      ),
      Result.andThen((row) => requireProject(row, projectId)),
    ),

  renameProject: (
    projectId: string,
    name: string,
  ): Result.Result<ProjectRow, ProjectNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .update(projects)
          .set({ name, updatedAt: new Date() })
          .where(eq(projects.id, projectId))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireProject(row, projectId)),
    ),

  /** 回答からの用語ページの自動作成を切り替える。 */
  setAutoTerms: (
    projectId: string,
    enabled: boolean,
  ): Result.Result<ProjectRow, ProjectNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .update(projects)
          .set({ autoTerms: enabled, updatedAt: new Date() })
          .where(eq(projects.id, projectId))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireProject(row, projectId)),
    ),

  /**
   * プロジェクトを消す。所属していた会話は消さず、未所属に戻す（外部キーの ON DELETE SET NULL）。
   * 参照していた Wiki は、ほかのプロジェクトが使っていなければページごと消す。
   */
  deleteProject: (
    projectId: string,
  ): Result.Result<ProjectRow, ProjectNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.transaction((tx) => {
          const row = tx
            .delete(projects)
            .where(eq(projects.id, projectId))
            .returning()
            .get();
          if (row === undefined) return undefined;
          const wikiId = wikiIdOf(row);
          const shared = tx
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.wikiId, wikiId), ne(projects.id, projectId)))
            .get();
          if (shared === undefined) {
            tx.delete(wikis).where(eq(wikis.id, wikiId)).run();
          }
          return row;
        }),
      ),
      Result.andThen((row) => requireProject(row, projectId)),
    ),

  /**
   * 進捗（状態・進捗メモ・次にやること）を更新する。指定した項目だけを変え、
   * 進捗の最終更新日時を今にする。会話の送信など、ほかの操作では変わらない。
   */
  updateProgress: (
    projectId: string,
    progress: {
      status?: ProjectStatus;
      progressNote?: string;
      nextAction?: string;
    },
  ): Result.Result<ProjectRow, ProjectNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() => {
        const now = new Date();
        return db
          .update(projects)
          .set({
            ...(progress.status === undefined
              ? {}
              : { status: progress.status }),
            ...(progress.progressNote === undefined
              ? {}
              : { progressNote: progress.progressNote }),
            ...(progress.nextAction === undefined
              ? {}
              : { nextAction: progress.nextAction }),
            progressUpdatedAt: now,
            updatedAt: now,
          })
          .where(eq(projects.id, projectId))
          .returning()
          .get();
      }),
      Result.andThen((row) => requireProject(row, projectId)),
    ),

  /** プロジェクトの関連リンク（登録した順）。 */
  listLinks: (
    projectId: string,
  ): Result.Result<ProjectLinkRow[], DatabaseError> =>
    run(() =>
      db
        .select()
        .from(projectLinks)
        .where(eq(projectLinks.projectId, projectId))
        .orderBy(asc(projectLinks.createdAt))
        .all(),
    ),

  createLink: (input: {
    projectId: string;
    url: string;
    label: string | null;
  }): Result.Result<ProjectLinkRow, DatabaseError> =>
    run(() => {
      const now = new Date();
      return db
        .insert(projectLinks)
        .values({
          id: crypto.randomUUID(),
          projectId: input.projectId,
          url: input.url,
          label: input.label,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    }),

  updateLink: (
    linkId: string,
    input: { url: string; label: string | null },
  ): Result.Result<ProjectLinkRow, ProjectLinkNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .update(projectLinks)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(projectLinks.id, linkId))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireLink(row, linkId)),
    ),

  deleteLink: (
    linkId: string,
  ): Result.Result<ProjectLinkRow, ProjectLinkNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .delete(projectLinks)
          .where(eq(projectLinks.id, linkId))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireLink(row, linkId)),
    ),
});

export type ProjectRepository = ReturnType<typeof createProjectRepository>;
