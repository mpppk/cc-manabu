import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { desc, eq } from "drizzle-orm";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";
import { type GoalRunRow, type GoalRunState, goalRuns } from "./schema.ts";

/** 同じタスクで、進行中（実行中・要確認）のゴールの実行がすでにある（#198）。 */
export class GoalRunAlreadyActiveError extends ErrorFactory({
  name: "GoalRunAlreadyActiveError",
  message: "このタスクのゴールはすでに実行中です。",
}) {}

/** 進行中の実行（多重起動を防ぐ対象）。 */
export const isActiveGoalRun = (state: GoalRunState): boolean =>
  state === "running" || state === "needs_review";

const run = <T>(fn: () => T): Result.Result<T, DatabaseError> =>
  Result.try({ try: fn, catch: (cause) => new DatabaseError({ cause }) });

const isUniqueViolation = (cause: unknown): boolean =>
  cause instanceof Error &&
  /UNIQUE constraint failed: goal_runs\.task_id/.test(cause.message);

export const createGoalRunRepository = (db: Db) => {
  /** タスクの最新の実行。 */
  const latestForTask = (
    taskId: string,
  ): Result.Result<GoalRunRow | undefined, DatabaseError> =>
    run(() =>
      db
        .select()
        .from(goalRuns)
        .where(eq(goalRuns.taskId, taskId))
        .orderBy(desc(goalRuns.createdAt))
        .limit(1)
        .get(),
    );

  return {
    /**
     * 実行を始める。同じタスクに進行中の実行があれば（同時に押した場合も含め）
     * GoalRunAlreadyActiveError（部分一意インデックスで防ぐ）。
     */
    start: (input: {
      taskId: string;
      chatId: string;
      goal: string;
    }): Result.Result<
      GoalRunRow,
      GoalRunAlreadyActiveError | DatabaseError
    > => {
      try {
        const now = new Date();
        return Result.succeed(
          db
            .insert(goalRuns)
            .values({
              id: crypto.randomUUID(),
              ...input,
              state: "running",
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get(),
        );
      } catch (cause) {
        return Result.fail(
          isUniqueViolation(cause)
            ? new GoalRunAlreadyActiveError({ cause })
            : new DatabaseError({ cause }),
        );
      }
    },

    latestForTask,

    /**
     * その会話がタスクの**最新の**実行のスレッドなら、その実行。
     * 通常のスレッドや、過去の実行のスレッドなら undefined（遅れて届いたイベントで更新しない）。
     */
    currentForChat: (
      chatId: string,
    ): Result.Result<GoalRunRow | undefined, DatabaseError> =>
      Result.pipe(
        run(() =>
          db
            .select()
            .from(goalRuns)
            .where(eq(goalRuns.chatId, chatId))
            .orderBy(desc(goalRuns.createdAt))
            .limit(1)
            .get(),
        ),
        Result.andThen((row) =>
          row === undefined
            ? Result.succeed(undefined)
            : Result.pipe(
                latestForTask(row.taskId),
                Result.map((latest) =>
                  latest?.id === row.id ? row : undefined,
                ),
              ),
        ),
      ),

    setState: (
      id: string,
      state: GoalRunState,
      reason: string,
    ): Result.Result<GoalRunRow | undefined, DatabaseError> =>
      run(() =>
        db
          .update(goalRuns)
          .set({ state, reason, updatedAt: new Date() })
          .where(eq(goalRuns.id, id))
          .returning()
          .get(),
      ),
  };
};

export type GoalRunRepository = ReturnType<typeof createGoalRunRepository>;
