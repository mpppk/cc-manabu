import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";
import { type EnvironmentRow, environments, tasks, wikis } from "./schema.ts";

export class EnvironmentNotFoundError extends ErrorFactory({
  name: "EnvironmentNotFoundError",
  message: (fields) => `Environment not found: ${fields.environmentId}`,
  fields: ErrorFactory.fields<{ environmentId: string }>(),
}) {}

export class EnvironmentNotEmptyError extends ErrorFactory({
  name: "EnvironmentNotEmptyError",
  message:
    "タスクがある環境は削除できません。タスクを別の環境に移すか、削除してから削除してください。",
}) {}

export class WikiNotFoundError extends ErrorFactory({
  name: "WikiNotFoundError",
  message: (fields) => `Wiki not found: ${fields.wikiId}`,
  fields: ErrorFactory.fields<{ wikiId: string }>(),
}) {}

/** 環境と、参照する Wiki の名前、属するタスクの数。 */
export type EnvironmentSummary = EnvironmentRow & {
  wikiName: string;
  taskCount: number;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const run = <T>(fn: () => T): Result.Result<T, DatabaseError> =>
  Result.try({ try: fn, catch: (cause) => new DatabaseError({ cause }) });

const wikiExists = (tx: Tx, wikiId: string): boolean =>
  tx.select({ id: wikis.id }).from(wikis).where(eq(wikis.id, wikiId)).get() !==
  undefined;

/**
 * 環境を作る（トランザクションの中で呼ぶ）。wikiId があればその Wiki を共有し、
 * 無ければ環境と同じ名前の Wiki を新しく作る。Wiki が見つからなければ undefined。
 */
export const insertEnvironment = (
  tx: Tx,
  input: {
    name: string;
    directories: string[];
    wikiId?: string;
    id?: string;
  },
  now: Date,
): EnvironmentRow | undefined => {
  let wikiId = input.wikiId;
  if (wikiId === undefined) {
    wikiId = crypto.randomUUID();
    tx.insert(wikis)
      .values({ id: wikiId, name: input.name, createdAt: now, updatedAt: now })
      .run();
  } else if (!wikiExists(tx, wikiId)) {
    return undefined;
  }
  return tx
    .insert(environments)
    .values({
      id: input.id ?? crypto.randomUUID(),
      name: input.name,
      wikiId,
      directories: input.directories,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
};

/** 環境の永続化。タスクの所属は tasks.environment_id に持つ。 */
export const createEnvironmentRepository = (db: Db) => {
  const requireEnvironment = (
    row: EnvironmentRow | undefined,
    environmentId: string,
  ): Result.Result<EnvironmentRow, EnvironmentNotFoundError> =>
    row === undefined
      ? Result.fail(new EnvironmentNotFoundError({ environmentId }))
      : Result.succeed(row);

  return {
    /** 作った順（並びが勝手に変わらないように）。 */
    listEnvironments: (): Result.Result<EnvironmentSummary[], DatabaseError> =>
      run(() => {
        const counts = new Map(
          db
            .select({ environmentId: tasks.environmentId, n: count() })
            .from(tasks)
            .groupBy(tasks.environmentId)
            .all()
            .map((row) => [row.environmentId, row.n]),
        );
        return db
          .select({ environment: environments, wikiName: wikis.name })
          .from(environments)
          .innerJoin(wikis, eq(wikis.id, environments.wikiId))
          .orderBy(asc(environments.createdAt))
          .all()
          .map(({ environment, wikiName }) => ({
            ...environment,
            wikiName,
            taskCount: counts.get(environment.id) ?? 0,
          }));
      }),

    getEnvironment: (
      environmentId: string,
    ): Result.Result<
      EnvironmentRow,
      EnvironmentNotFoundError | DatabaseError
    > =>
      Result.pipe(
        run(() =>
          db
            .select()
            .from(environments)
            .where(eq(environments.id, environmentId))
            .get(),
        ),
        Result.andThen((row) => requireEnvironment(row, environmentId)),
      ),

    /** タスクが属する環境のディレクトリ。タスクか環境が無ければ undefined。 */
    directoriesOfTask: (
      taskId: string,
    ): Result.Result<string[] | undefined, DatabaseError> =>
      run(
        () =>
          db
            .select({ directories: environments.directories })
            .from(tasks)
            .innerJoin(environments, eq(environments.id, tasks.environmentId))
            .where(eq(tasks.id, taskId))
            .get()?.directories,
      ),

    createEnvironment: (input: {
      name: string;
      directories: string[];
      wikiId?: string;
      id?: string;
    }): Result.Result<EnvironmentRow, WikiNotFoundError | DatabaseError> =>
      Result.pipe(
        run(() =>
          db.transaction((tx) => insertEnvironment(tx, input, new Date())),
        ),
        Result.andThen((row) =>
          row === undefined
            ? Result.fail(new WikiNotFoundError({ wikiId: input.wikiId ?? "" }))
            : Result.succeed(row),
        ),
      ),

    /**
     * 名前・ディレクトリ・参照する Wiki を変える（指定した項目だけ）。
     * Wiki を変えると、属するタスクの Wiki も合わせる。元の Wiki はページごと残る。
     */
    updateEnvironment: (
      environmentId: string,
      input: { name?: string; directories?: string[]; wikiId?: string },
    ): Result.Result<
      EnvironmentRow,
      EnvironmentNotFoundError | WikiNotFoundError | DatabaseError
    > =>
      Result.pipe(
        run(() =>
          db.transaction((tx) => {
            if (input.wikiId !== undefined && !wikiExists(tx, input.wikiId)) {
              return { kind: "wiki-not-found" as const };
            }
            const now = new Date();
            const row = tx
              .update(environments)
              .set({
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.directories === undefined
                  ? {}
                  : { directories: input.directories }),
                ...(input.wikiId === undefined ? {} : { wikiId: input.wikiId }),
                updatedAt: now,
              })
              .where(eq(environments.id, environmentId))
              .returning()
              .get();
            if (row !== undefined && input.wikiId !== undefined) {
              tx.update(tasks)
                .set({ wikiId: input.wikiId })
                .where(eq(tasks.environmentId, environmentId))
                .run();
            }
            return { kind: "updated" as const, row };
          }),
        ),
        Result.andThen((result) =>
          result.kind === "wiki-not-found"
            ? Result.fail(new WikiNotFoundError({ wikiId: input.wikiId ?? "" }))
            : requireEnvironment(result.row, environmentId),
        ),
      ),

    /**
     * 環境を消す。タスクがあれば消さない。参照していた Wiki は、
     * ほかの環境が使っていなければページごと消す。
     */
    deleteEnvironment: (
      environmentId: string,
    ): Result.Result<
      EnvironmentRow,
      EnvironmentNotFoundError | EnvironmentNotEmptyError | DatabaseError
    > =>
      Result.pipe(
        run(() =>
          db.transaction((tx) => {
            const used = tx
              .select({ id: tasks.id })
              .from(tasks)
              .where(eq(tasks.environmentId, environmentId))
              .get();
            if (used !== undefined) return { kind: "not-empty" as const };
            const row = tx
              .delete(environments)
              .where(eq(environments.id, environmentId))
              .returning()
              .get();
            if (row === undefined) return { kind: "deleted" as const, row };
            const shared = tx
              .select({ id: environments.id })
              .from(environments)
              .where(
                and(
                  eq(environments.wikiId, row.wikiId),
                  ne(environments.id, environmentId),
                ),
              )
              .get();
            // 古いタスクが写しで参照していることはないが、念のため確かめる
            const referenced = tx
              .select({ id: tasks.id })
              .from(tasks)
              .where(eq(tasks.wikiId, row.wikiId))
              .get();
            if (shared === undefined && referenced === undefined) {
              tx.delete(wikis).where(eq(wikis.id, row.wikiId)).run();
            }
            return { kind: "deleted" as const, row };
          }),
        ),
        Result.andThen((result) =>
          result.kind === "not-empty"
            ? Result.fail(new EnvironmentNotEmptyError())
            : requireEnvironment(result.row, environmentId),
        ),
      ),

    /**
     * ディレクトリが空の環境（移行で会話が無かったもの）を、起動したディレクトリで埋める。
     * 埋めた数を返す。
     */
    fillEmptyDirectories: (cwd: string): Result.Result<number, DatabaseError> =>
      run(
        () =>
          db
            .update(environments)
            .set({ directories: [cwd] })
            .where(sql`json_array_length(${environments.directories}) = 0`)
            .returning({ id: environments.id })
            .all().length,
      ),
  };
};

export type EnvironmentRepository = ReturnType<
  typeof createEnvironmentRepository
>;
