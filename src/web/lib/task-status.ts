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

/**
 * 選んだ進捗のどれかに当てはまるタスク（#195）。何も選んでいなければすべて。
 */
export const filterTasksByStatus = <T extends { status: TaskStatus }>(
  tasks: readonly T[],
  statuses: readonly TaskStatus[],
): T[] =>
  statuses.length === 0
    ? [...tasks]
    : tasks.filter((task) => statuses.includes(task.status));

const STATUS_FILTER_KEY = "cc-manabu.sidebarStatusFilter";

/** 左パネルの進捗の絞り込み（ブラウザに覚える）。読めなければ絞り込まない。 */
export const loadStatusFilter = (): TaskStatus[] => {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STATUS_FILTER_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? TASK_STATUS_ORDER.filter((status) => parsed.includes(status))
      : [];
  } catch {
    return [];
  }
};

export const saveStatusFilter = (statuses: readonly TaskStatus[]) => {
  try {
    localStorage.setItem(STATUS_FILTER_KEY, JSON.stringify(statuses));
  } catch {
    // 覚えられなくても絞り込みはできる
  }
};
