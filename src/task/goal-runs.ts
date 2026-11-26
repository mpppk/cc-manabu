/**
 * タスクのゴールの実行（#198）。
 *
 * - 「実行」で、タスクに属する新しいスレッドを作り、最初のメッセージを `/goal <ゴール>` にして
 *   既存の送信経路（承認・中断・保存）で Claude Code のネイティブの `/goal` を走らせる
 * - 実行のスレッドのイベントで、タスクの進捗を自動で更新する
 *
 * | 実行の状況                               | 実行       | タスク |
 * | ---------------------------------------- | ---------- | ------ |
 * | 開始した・利用者の対応で再開した          | running    | 進行中 |
 * | ツールの承認を待っている                  | needs_review | 要確認 |
 * | 判定できないまま止まった（質問・判断待ち） | needs_review | 要確認 |
 * | `/goal` の評価で達成を確認した            | achieved   | 完了   |
 * | 達成不能・エラー                          | failed     | 保留   |
 * | 利用者が止めた                            | stopped    | 保留   |
 *
 * 自動の更新は、タスクの**最新の**実行のスレッドのイベントでだけ行う（通常のスレッドや過去の実行は無視）。
 */
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import type { ChatService, SendError } from "../chat/chat-service.ts";
import type { ChatRepository, DatabaseError } from "../db/chat-repository.ts";
import type { EnvironmentRepository } from "../db/environment-repository.ts";
import {
  GoalRunAlreadyActiveError,
  type GoalRunRepository,
  isActiveGoalRun,
} from "../db/goal-run-repository.ts";
import type { PreferencesRepository } from "../db/preferences-repository.ts";
import type { GoalRunRow, GoalRunState, TaskStatus } from "../db/schema.ts";
import type {
  TaskNotFoundError,
  TaskRepository,
} from "../db/task-repository.ts";
import type { GoalVerdictReader } from "./goal-verdict.ts";

/** ゴールが空のタスクは実行できない。 */
export class GoalNotSetError extends ErrorFactory({
  name: "GoalNotSetError",
  message: "ゴールを設定してから実行してください。",
}) {}

/** 止める実行が無い。 */
export class GoalRunNotActiveError extends ErrorFactory({
  name: "GoalRunNotActiveError",
  message: "実行中のゴールはありません。",
}) {}

/** Claude Code の `/goal` の条件の上限（文字数）。 */
export const MAX_GOAL_LENGTH = 4000;

const TASK_STATUS_OF: Record<GoalRunState, TaskStatus> = {
  running: "in_progress",
  needs_review: "needs_review",
  achieved: "done",
  failed: "on_hold",
  stopped: "on_hold",
};

export const REASONS = {
  approval:
    "ツールの実行の承認を待っています。実行のスレッドで確認してください。",
  undetermined:
    "ゴールの達成を判定できないまま止まりました。実行のスレッドで Claude の質問や状況を確認し、続けるか止めてください。",
  stopped: "実行を停止しました。",
  error: "エラーで止まりました。実行のスレッドでエラーを確認してください。",
} as const;

type Deps = {
  tasks: Pick<TaskRepository, "getTask" | "updateProgress">;
  chats: Pick<ChatRepository, "createChat" | "getChat">;
  environments: Pick<EnvironmentRepository, "directoriesOfTask">;
  goalRuns: GoalRunRepository;
  preferences?: Pick<PreferencesRepository, "chatDefaults">;
  chatService: Pick<ChatService, "send" | "stop">;
  readVerdict: GoalVerdictReader;
  /** タスクの環境にディレクトリが無いときの作業ディレクトリ。 */
  cwd: string;
  onError?: (error: unknown) => void;
};

export type GoalRunError =
  | GoalNotSetError
  | GoalRunAlreadyActiveError
  | TaskNotFoundError
  | DatabaseError
  | SendError;

export const createGoalRuns = (deps: Deps) => {
  const onError =
    deps.onError ??
    ((error: unknown) =>
      console.warn("ゴールの実行の状態を更新できませんでした:", error));

  /** 実行とタスクの進捗を、新しい状態にそろえる。 */
  const transition = (run: GoalRunRow, state: GoalRunState, reason: string) => {
    const updated = deps.goalRuns.setState(run.id, state, reason);
    if (Result.isFailure(updated)) return onError(updated.error);
    const task = deps.tasks.updateProgress(run.taskId, {
      status: TASK_STATUS_OF[state],
    });
    if (Result.isFailure(task)) onError(task.error);
  };

  /** タスクの最新の実行のスレッドなら、その実行。 */
  const currentRun = (chatId: string): GoalRunRow | undefined => {
    const run = deps.goalRuns.currentForChat(chatId);
    if (Result.isFailure(run)) {
      onError(run.error);
      return undefined;
    }
    return run.value;
  };

  return {
    /** タスクの最新の実行（無ければ undefined）。 */
    latest: (taskId: string) => deps.goalRuns.latestForTask(taskId),

    /** ゴールの実行を始める。作ったスレッドと実行を返す。 */
    start: (
      taskId: string,
    ): Result.Result<{ chatId: string; run: GoalRunRow }, GoalRunError> => {
      const task = deps.tasks.getTask(taskId);
      if (Result.isFailure(task)) return task;
      const goal = task.value.nextAction.trim();
      if (goal === "") return Result.fail(new GoalNotSetError());
      const latest = deps.goalRuns.latestForTask(taskId);
      if (Result.isFailure(latest)) return latest;
      // 先に確かめて、空のスレッドを作らない（同時に押したときは部分一意インデックスで防ぐ）
      if (latest.value !== undefined && isActiveGoalRun(latest.value.state)) {
        return Result.fail(new GoalRunAlreadyActiveError());
      }
      const directories = deps.environments.directoriesOfTask(taskId);
      if (Result.isFailure(directories)) return directories;
      const defaults = deps.preferences?.chatDefaults();
      const saved =
        defaults !== undefined && Result.isSuccess(defaults)
          ? defaults.value
          : null;
      const chat = deps.chats.createChat({
        cwd: directories.value?.[0] ?? deps.cwd,
        taskId,
        ...(saved === null ? {} : { model: saved.model, effort: saved.effort }),
      });
      if (Result.isFailure(chat)) return chat;
      const run = deps.goalRuns.start({
        taskId,
        chatId: chat.value.id,
        goal,
      });
      if (Result.isFailure(run)) return run;
      const progressed = deps.tasks.updateProgress(taskId, {
        status: "in_progress",
      });
      if (Result.isFailure(progressed)) onError(progressed.error);
      const sent = deps.chatService.send({
        chatId: chat.value.id,
        message: {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: `/goal ${goal}` }],
        },
      });
      if (Result.isFailure(sent)) {
        transition(run.value, "failed", sent.error.message);
        return sent;
      }
      return Result.succeed({ chatId: chat.value.id, run: run.value });
    },

    /** 進行中の実行を止める。生成中なら中断し、タスクを保留にする。 */
    stop: (
      taskId: string,
    ): Result.Result<GoalRunRow, GoalRunNotActiveError | DatabaseError> => {
      const latest = deps.goalRuns.latestForTask(taskId);
      if (Result.isFailure(latest)) return latest;
      const run = latest.value;
      if (run === undefined || !isActiveGoalRun(run.state)) {
        return Result.fail(new GoalRunNotActiveError());
      }
      transition(run, "stopped", REASONS.stopped);
      deps.chatService.stop(run.chatId);
      return Result.succeed({
        ...run,
        state: "stopped",
        reason: REASONS.stopped,
      });
    },

    /** 実行のスレッドで生成が始まった（利用者が対応して再開したときを含む）。 */
    onRunnerStart: (chatId: string) => {
      const run = currentRun(chatId);
      if (run?.state === "needs_review") transition(run, "running", "");
    },

    /** ツールの承認待ちの数が変わった。 */
    onPendingChange: (chatId: string, count: number) => {
      const run = currentRun(chatId);
      if (run === undefined) return;
      if (count > 0 && run.state === "running") {
        transition(run, "needs_review", REASONS.approval);
      } else if (
        count === 0 &&
        run.state === "needs_review" &&
        run.reason === REASONS.approval
      ) {
        transition(run, "running", "");
      }
    },

    /** 実行のスレッドで生成が終わった。`/goal` の評価を読んで進捗を決める。 */
    onRunnerFinish: async (
      chatId: string,
      outcome: "success" | "aborted" | "error",
    ) => {
      const run = currentRun(chatId);
      if (run === undefined || !isActiveGoalRun(run.state)) return;
      if (outcome === "aborted") {
        return transition(run, "stopped", REASONS.stopped);
      }
      if (outcome === "error") {
        return transition(run, "failed", REASONS.error);
      }
      const chat = deps.chats.getChat(chatId);
      const sessionId = Result.isSuccess(chat)
        ? (chat.value.chat.sessionId ?? null)
        : null;
      const verdict =
        sessionId === null
          ? { kind: "none" as const, reason: "" }
          : await deps.readVerdict(sessionId).catch((error: unknown) => {
              onError(error);
              return { kind: "none" as const, reason: "" };
            });
      // 読んでいる間に止められた・別の実行が始まったなら、更新しない
      const current = currentRun(chatId);
      if (current?.id !== run.id || !isActiveGoalRun(current.state)) return;
      if (verdict.kind === "met") {
        transition(current, "achieved", verdict.reason);
      } else if (verdict.kind === "failed") {
        transition(current, "failed", verdict.reason);
      } else {
        transition(current, "needs_review", REASONS.undetermined);
      }
    },
  };
};

export type GoalRuns = ReturnType<typeof createGoalRuns>;
