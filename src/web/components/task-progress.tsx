import { ClipboardList, Play, Square } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { GoalRunState, TaskStatus } from "../../db/schema.ts";
import type { GoalRunDto, TaskDto } from "../../router.ts";
import type { ApiClient } from "../lib/orpc.ts";
import {
  formatDateTime,
  isTaskStatus,
  TASK_STATUS_CLASSES,
  TASK_STATUS_LABELS,
  TASK_STATUS_ORDER,
} from "../lib/task-status.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";

export const TaskStatusBadge = ({ status }: { status: TaskStatus }) => (
  <span
    className={cn(
      "shrink-0 rounded px-1.5 py-0.5 text-xs",
      TASK_STATUS_CLASSES[status],
    )}
  >
    {TASK_STATUS_LABELS[status]}
  </span>
);

/** タスクの進捗（状態・進捗メモ・ゴール）。状態は選ぶとすぐ保存する。 */
export const TaskProgress = ({
  api,
  task,
  onChanged,
  onOpenChat,
}: {
  api: ApiClient;
  task: TaskDto;
  onChanged: () => Promise<void>;
  /** ゴールの実行のスレッドを開く（#198）。 */
  onOpenChat: (chatId: string) => void;
}) => {
  const [note, setNote] = useState(task.progressNote);
  const [next, setNext] = useState(task.nextAction);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const dirty = note !== task.progressNote || next.trim() !== task.nextAction;

  const update = async (
    progress: Parameters<ApiClient["tasks"]["updateProgress"]>[0],
  ) => {
    setError(undefined);
    try {
      await api.tasks.updateProgress(progress);
      await onChanged();
      return true;
    } catch {
      setError("保存できませんでした。");
      return false;
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    if (await update({ id: task.id, progressNote: note, nextAction: next })) {
      setSaved(true);
    }
  };

  return (
    <section aria-labelledby="task-progress" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="task-progress"
          className="flex items-center gap-2 font-semibold text-base"
        >
          <ClipboardList className="size-4" />
          進捗
        </h2>
        <span className="text-muted-foreground text-xs">
          最終更新: {formatDateTime(task.progressUpdatedAt)}
        </span>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <span className="w-24 shrink-0 text-muted-foreground">状態</span>
        <select
          className="rounded-md border bg-background px-2 py-1.5 text-sm"
          aria-label="状態"
          value={task.status}
          onChange={(event) => {
            if (isTaskStatus(event.target.value)) {
              void update({ id: task.id, status: event.target.value });
            }
          }}
        >
          {TASK_STATUS_ORDER.map((status) => (
            <option key={status} value={status}>
              {TASK_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <TaskStatusBadge status={task.status} />
      </label>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <label className="flex items-start gap-3 text-sm">
          <span className="mt-2 w-24 shrink-0 text-muted-foreground">
            ゴール
          </span>
          <span className="flex flex-1 flex-col gap-1">
            <textarea
              className="min-h-16 resize-y rounded-md border bg-background px-3 py-2"
              aria-label="ゴール"
              aria-describedby="task-goal-help"
              placeholder="例: bun test がすべて通り、README に使い方が書かれている"
              maxLength={4000}
              value={next}
              onChange={(event) => {
                setNext(event.target.value);
                setSaved(false);
              }}
            />
            <span id="task-goal-help" className="text-muted-foreground text-xs">
              達成したかを判定できる条件を書きます。「実行」で Claude
              がこのゴールに向けて作業します。
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <span className="mt-2 w-24 shrink-0 text-muted-foreground">
            進捗メモ
          </span>
          <textarea
            className="min-h-24 flex-1 resize-y rounded-md border bg-background px-3 py-2"
            aria-label="進捗メモ"
            placeholder="どこまで進んだか、決めたこと、再開時に見るものなど"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <div className="flex items-center justify-end gap-3">
          {error !== undefined && (
            <span className="text-destructive text-sm" role="alert">
              {error}
            </span>
          )}
          {saved && !dirty && (
            <span className="text-muted-foreground text-sm" role="status">
              保存しました
            </span>
          )}
          <Button type="submit" size="sm" disabled={!dirty}>
            進捗を保存
          </Button>
        </div>
      </form>
      <GoalRunPanel
        api={api}
        task={task}
        unsaved={dirty}
        onChanged={onChanged}
        onOpenChat={onOpenChat}
      />
    </section>
  );
};

const GOAL_RUN_LABELS: Record<GoalRunState, string> = {
  running: "実行中",
  needs_review: "要確認",
  achieved: "達成",
  failed: "達成できず",
  stopped: "停止",
};

const GOAL_RUN_CLASSES: Record<GoalRunState, string> = {
  running: TASK_STATUS_CLASSES.in_progress,
  needs_review: TASK_STATUS_CLASSES.needs_review,
  achieved: TASK_STATUS_CLASSES.done,
  failed: TASK_STATUS_CLASSES.on_hold,
  stopped: TASK_STATUS_CLASSES.on_hold,
};

const isActive = (run: GoalRunDto | null | undefined) =>
  run?.state === "running" || run?.state === "needs_review";

/**
 * ゴールの実行（#198）。「実行」で、タスクに属する新しいスレッドを作って開き、
 * 保存済みのゴールで Claude Code の `/goal` を始める。最新の実行の状態と理由、スレッドへの移動を出す。
 */
const GoalRunPanel = ({
  api,
  task,
  unsaved,
  onChanged,
  onOpenChat,
}: {
  api: ApiClient;
  task: TaskDto;
  /** ゴールを書き換えて、まだ保存していない。 */
  unsaved: boolean;
  onChanged: () => Promise<void>;
  onOpenChat: (chatId: string) => void;
}) => {
  const [run, setRun] = useState<GoalRunDto | null>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = isActive(run);

  const load = useCallback(async () => {
    try {
      setRun(await api.tasks.goalRun({ id: task.id }));
    } catch {
      // 次の取り直しで出す
    }
  }, [api, task.id]);

  // 進捗が変わったら取り直す。実行中は定期的に取り直す
  // biome-ignore lint/correctness/useExhaustiveDependencies: タスクの状態が変わったときにも取り直す
  useEffect(() => {
    void load();
  }, [load, task.status]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [active, load]);

  const goal = task.nextAction.trim();
  const start = async () => {
    setError(undefined);
    setPending(true);
    try {
      const started = await api.tasks.runGoal({ id: task.id });
      setRun(started.run);
      await onChanged();
      onOpenChat(started.chatId);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message !== ""
          ? cause.message
          : "実行を始められませんでした。",
      );
      await load();
    } finally {
      setPending(false);
    }
  };
  const stop = async () => {
    setError(undefined);
    setPending(true);
    try {
      setRun(await api.tasks.stopGoal({ id: task.id }));
      await onChanged();
    } catch {
      setError("止められませんでした。");
      await load();
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      className="flex flex-col gap-2 rounded-md border p-3 text-sm"
      aria-label="ゴールの実行"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">ゴールの実行</span>
        {run != null && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-xs",
              GOAL_RUN_CLASSES[run.state],
            )}
            data-testid="goal-run-state"
          >
            {GOAL_RUN_LABELS[run.state]}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {active ? (
            <Button
              key="stop"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void stop()}
            >
              <Square />
              停止
            </Button>
          ) : (
            <Button
              key="run"
              size="sm"
              disabled={pending || goal === "" || unsaved}
              onClick={() => void start()}
            >
              <Play />
              {run == null ? "実行" : "再実行"}
            </Button>
          )}
        </span>
      </div>
      {goal === "" && !active && (
        <p className="text-muted-foreground text-xs">
          ゴールを設定して保存すると実行できます。
        </p>
      )}
      {goal !== "" && unsaved && !active && (
        <p className="text-muted-foreground text-xs">
          ゴールを保存してから実行してください。
        </p>
      )}
      {run != null && (
        <>
          {run.reason !== "" && (
            <p
              className="whitespace-pre-wrap break-words text-xs"
              data-testid="goal-run-reason"
            >
              {run.reason}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <span>開始: {formatDateTime(run.createdAt)}</span>
            <button
              type="button"
              className="text-primary underline-offset-4 hover:underline"
              onClick={() => onOpenChat(run.chatId)}
            >
              {active ? "実行中のスレッドを開く" : "直近の実行のスレッドを開く"}
            </button>
          </div>
        </>
      )}
      {error !== undefined && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </section>
  );
};
