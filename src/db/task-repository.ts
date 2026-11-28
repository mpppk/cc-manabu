import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { asc, count, eq } from "drizzle-orm";
import { DatabaseError } from "./chat-repository.ts";
import {
  EnvironmentNotFoundError,
  insertEnvironment,
  WikiNotFoundError,
} from "./environment-repository.ts";
import type { Db } from "./index.ts";
import {
  environments,
  type TaskLinkRow,
  type TaskRow,
  type TaskStatus,
  taskLinks,
  tasks,
  type WikiRow,
  wikis,
} from "./schema.ts";

export { WikiNotFoundError };

/** タスクの環境が Wiki を使っていない（#232）。 */
export class TaskWithoutWikiError extends ErrorFactory({
  name: "TaskWithoutWikiError",
  message: "このタスクの環境は Wiki を使っていません。",
}) {}

/** タスクが参照する Wiki。環境が Wiki を使っていなければ null（#232）。 */
export const wikiIdOf = (task: Pick<TaskRow, "wikiId">): string | null =>
  task.wikiId;

/** タスクが参照する Wiki。環境が Wiki を使っていなければ TaskWithoutWikiError。 */
export const requireWikiId = (
  task: Pick<TaskRow, "wikiId">,
): Result.Result<string, TaskWithoutWikiError> =>
  task.wikiId === null
    ? Result.fail(new TaskWithoutWikiError())
    : Result.succeed(task.wikiId);

/** Wiki と、それを参照しているタスクの数。 */
export type WikiSummary = WikiRow & { taskCount: number };

export class TaskNotFoundError extends ErrorFactory({
  name: "TaskNotFoundError",
  message: (fields) => `Task not found: ${fields.taskId}`,
  fields: ErrorFactory.fields<{ taskId: string }>(),
}) {}

export class TaskLinkNotFoundError extends ErrorFactory({
  name: "TaskLinkNotFoundError",
  message: (fields) => `Task link not found: ${fields.linkId}`,
  fields: ErrorFactory.fields<{ linkId: string }>(),
}) {}

const requireLink = (
  row: TaskLinkRow | undefined,
  linkId: string,
): Result.Result<TaskLinkRow, TaskLinkNotFoundError> =>
  row === undefined
    ? Result.fail(new TaskLinkNotFoundError({ linkId }))
    : Result.succeed(row);

const run = <T>(fn: () => T): Result.Result<T, DatabaseError> =>
  Result.try({ try: fn, catch: (cause) => new DatabaseError({ cause }) });

const requireTask = (
  row: TaskRow | undefined,
  taskId: string,
): Result.Result<TaskRow, TaskNotFoundError> =>
  row === undefined
    ? Result.fail(new TaskNotFoundError({ taskId }))
    : Result.succeed(row);

/** タスクの永続化。会話の所属は chats.task_id に持つ。 */
export const createTaskRepository = (db: Db) => ({
  /**
   * タスクを作る。environmentId があればその環境に入れ、無ければタスクと同じ名前の環境
   * （directories のディレクトリと、新しい Wiki）を作って入れる。
   */
  createTask: (input: {
    name: string;
    id?: string;
    environmentId?: string;
    /** 環境を新しく作るときのディレクトリ。 */
    directories?: string[];
  }): Result.Result<TaskRow, EnvironmentNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.transaction((tx) => {
          const now = new Date();
          const environment =
            input.environmentId === undefined
              ? insertEnvironment(
                  tx,
                  { name: input.name, directories: input.directories ?? [] },
                  now,
                )
              : tx
                  .select()
                  .from(environments)
                  .where(eq(environments.id, input.environmentId))
                  .get();
          if (environment === undefined) return undefined;
          return tx
            .insert(tasks)
            .values({
              id: input.id ?? crypto.randomUUID(),
              name: input.name,
              environmentId: environment.id,
              wikiId: environment.wikiId,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
        }),
      ),
      Result.andThen((row) =>
        row === undefined
          ? Result.fail(
              new EnvironmentNotFoundError({
                environmentId: input.environmentId ?? "",
              }),
            )
          : Result.succeed(row),
      ),
    ),

  /** タスクを別の環境に移す。参照する Wiki も移った環境のものになる。 */
  setEnvironment: (
    taskId: string,
    environmentId: string,
  ): Result.Result<
    TaskRow,
    TaskNotFoundError | EnvironmentNotFoundError | DatabaseError
  > =>
    Result.pipe(
      run(() =>
        db.transaction((tx) => {
          const environment = tx
            .select()
            .from(environments)
            .where(eq(environments.id, environmentId))
            .get();
          if (environment === undefined) {
            return { kind: "environment-not-found" as const };
          }
          const row = tx
            .update(tasks)
            .set({
              environmentId,
              wikiId: environment.wikiId,
              updatedAt: new Date(),
            })
            .where(eq(tasks.id, taskId))
            .returning()
            .get();
          return { kind: "updated" as const, row };
        }),
      ),
      Result.andThen((result) =>
        result.kind === "environment-not-found"
          ? Result.fail(new EnvironmentNotFoundError({ environmentId }))
          : requireTask(result.row, taskId),
      ),
    ),

  /** Wiki（作った順）と、参照しているタスクの数。 */
  listWikis: (): Result.Result<WikiSummary[], DatabaseError> =>
    run(() => {
      const counts = new Map(
        db
          .select({ wikiId: tasks.wikiId, n: count() })
          .from(tasks)
          .groupBy(tasks.wikiId)
          .all()
          .map((row) => [row.wikiId, row.n]),
      );
      return db
        .select()
        .from(wikis)
        .orderBy(asc(wikis.createdAt))
        .all()
        .map((wiki) => ({ ...wiki, taskCount: counts.get(wiki.id) ?? 0 }));
    }),

  /** Wiki の名前を変える（共有しているすべてのタスクに反映される）。 */
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
  listTasks: (): Result.Result<TaskRow[], DatabaseError> =>
    run(() => db.select().from(tasks).orderBy(asc(tasks.createdAt)).all()),

  getTask: (
    taskId: string,
  ): Result.Result<TaskRow, TaskNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() => db.select().from(tasks).where(eq(tasks.id, taskId)).get()),
      Result.andThen((row) => requireTask(row, taskId)),
    ),

  renameTask: (
    taskId: string,
    name: string,
  ): Result.Result<TaskRow, TaskNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .update(tasks)
          .set({ name, updatedAt: new Date() })
          .where(eq(tasks.id, taskId))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireTask(row, taskId)),
    ),

  /**
   * タスクをアーカイブする・復元する（#241）。進捗の状態・環境・ゴールなどは変えず、
   * アーカイブした日時だけを付け外しする。すでにその状態なら日時も変えない。
   */
  setArchived: (
    taskId: string,
    archived: boolean,
  ): Result.Result<TaskRow, TaskNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.transaction((tx) => {
          const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
          if (row === undefined || (row.archivedAt !== null) === archived) {
            return row;
          }
          const now = new Date();
          return tx
            .update(tasks)
            .set({ archivedAt: archived ? now : null, updatedAt: now })
            .where(eq(tasks.id, taskId))
            .returning()
            .get();
        }),
      ),
      Result.andThen((row) => requireTask(row, taskId)),
    ),

  /** 回答からの用語ページの自動作成を切り替える。 */
  setAutoTerms: (
    taskId: string,
    enabled: boolean,
  ): Result.Result<TaskRow, TaskNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .update(tasks)
          .set({ autoTerms: enabled, updatedAt: new Date() })
          .where(eq(tasks.id, taskId))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireTask(row, taskId)),
    ),

  /**
   * タスクを消す。所属していた会話は消さず、未所属に戻す（外部キーの ON DELETE SET NULL）。
   * Wiki は環境のものなので残る。
   */
  deleteTask: (
    taskId: string,
  ): Result.Result<TaskRow, TaskNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() => db.delete(tasks).where(eq(tasks.id, taskId)).returning().get()),
      Result.andThen((row) => requireTask(row, taskId)),
    ),

  /**
   * 進捗（状態・進捗メモ・ゴール）を更新する。指定した項目だけを変え、
   * 進捗の最終更新日時を今にする。会話の送信など、ほかの操作では変わらない。
   */
  updateProgress: (
    taskId: string,
    progress: {
      status?: TaskStatus;
      progressNote?: string;
      nextAction?: string;
    },
  ): Result.Result<TaskRow, TaskNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() => {
        const now = new Date();
        return db
          .update(tasks)
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
          .where(eq(tasks.id, taskId))
          .returning()
          .get();
      }),
      Result.andThen((row) => requireTask(row, taskId)),
    ),

  /** タスクの関連リンク（登録した順）。 */
  listLinks: (taskId: string): Result.Result<TaskLinkRow[], DatabaseError> =>
    run(() =>
      db
        .select()
        .from(taskLinks)
        .where(eq(taskLinks.taskId, taskId))
        .orderBy(asc(taskLinks.createdAt))
        .all(),
    ),

  createLink: (input: {
    taskId: string;
    url: string;
    label: string | null;
  }): Result.Result<TaskLinkRow, DatabaseError> =>
    run(() => {
      const now = new Date();
      return db
        .insert(taskLinks)
        .values({
          id: crypto.randomUUID(),
          taskId: input.taskId,
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
  ): Result.Result<TaskLinkRow, TaskLinkNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .update(taskLinks)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(taskLinks.id, linkId))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireLink(row, linkId)),
    ),

  deleteLink: (
    linkId: string,
  ): Result.Result<TaskLinkRow, TaskLinkNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.delete(taskLinks).where(eq(taskLinks.id, linkId)).returning().get(),
      ),
      Result.andThen((row) => requireLink(row, linkId)),
    ),
});

export type TaskRepository = ReturnType<typeof createTaskRepository>;
