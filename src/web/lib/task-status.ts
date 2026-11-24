import type { TaskStatus } from "../../db/schema.ts";

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "未着手",
  in_progress: "進行中",
  on_hold: "保留",
  done: "完了",
};

/** 一覧や選択肢に並べる順。 */
export const TASK_STATUS_ORDER: TaskStatus[] = [
  "not_started",
  "in_progress",
  "on_hold",
  "done",
];

export const isTaskStatus = (value: string): value is TaskStatus =>
  (TASK_STATUS_ORDER as string[]).includes(value);

/** 状態のバッジの色。 */
export const TASK_STATUS_CLASSES: Record<TaskStatus, string> = {
  not_started: "bg-muted text-muted-foreground",
  in_progress: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  on_hold: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
};

export const formatDateTime = (value: Date | string | null): string =>
  value === null ? "—" : new Date(value).toLocaleString("ja-JP");
