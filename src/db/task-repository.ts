import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";
import {
  type TaskLinkRow,
  type TaskRow,
  type TaskStatus,
  taskLinks,
  tasks,
  type WikiRow,
  wikis,
} from "./schema.ts";

export class WikiNotFoundError extends ErrorFactory({
  name: "WikiNotFoundError",
  message: (fields) => `Wiki not found: ${fields.wikiId}`,
  fields: ErrorFactory.fields<{ wikiId: string }>(),
}) {}

/** タスクが参照する Wiki。古い行で未設定なら、移行で作った同じ ID の Wiki。 */
export const wikiIdOf = (task: Pick<TaskRow, "id" | "wikiId">): string =>
  task.wikiId ?? task.id;

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

/** タスクの永続化。会話の所属は chats.project_id に持つ。 */
export const createTaskRepository = (db: Db) => ({
  /**
   * タスクを作る。wikiId があればその Wiki を共有し、無ければ同じ名前の Wiki を新しく作る。
   */
  createTask: (input: {
    name: string;
    id?: string;
    wikiId?: string;
  }): Result.Result<TaskRow, WikiNotFoundError | DatabaseError> =>
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
            .insert(tasks)
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
   * 参照していた Wiki は、ほかのタスクが使っていなければページごと消す。
   */
  deleteTask: (
    taskId: string,
  ): Result.Result<TaskRow, TaskNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.transaction((tx) => {
          const row = tx
            .delete(tasks)
            .where(eq(tasks.id, taskId))
            .returning()
            .get();
          if (row === undefined) return undefined;
          const wikiId = wikiIdOf(row);
          const shared = tx
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.wikiId, wikiId), ne(tasks.id, taskId)))
            .get();
          if (shared === undefined) {
            tx.delete(wikis).where(eq(wikis.id, wikiId)).run();
          }
          return row;
        }),
      ),
      Result.andThen((row) => requireTask(row, taskId)),
    ),

  /**
   * 進捗（状態・進捗メモ・次にやること）を更新する。指定した項目だけを変え、
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
