import { useState } from "react";
import type { TaskStatus } from "../../db/schema.ts";
import type { TaskDto } from "../../router.ts";
import { appHistory } from "../lib/app-history.ts";
import {
  formatDateTime,
  isTaskStatus,
  TASK_STATUS_LABELS,
  TASK_STATUS_ORDER,
} from "../lib/task-status.ts";
import { TaskStatusBadge } from "./task-progress.tsx";
import { Button } from "./ui/button.tsx";

/** URL の ?status= から絞り込みを読む（リロードしても保つ）。 */
const statusFromUrl = (): TaskStatus | undefined => {
  const value = new URLSearchParams(appHistory().location().search).get(
    "status",
  );
  return value !== null && isTaskStatus(value) ? value : undefined;
};

/** タスク一覧（`/tasks`）。状態・次にやること・進捗の最終更新を並べ、状態で絞り込む。 */
export const TaskList = ({
  tasks,
  onOpen,
}: {
  tasks: TaskDto[];
  onOpen: (taskId: string) => void;
}) => {
  const [filter, setFilter] = useState<TaskStatus | undefined>(statusFromUrl);
  const choose = (next: TaskStatus | undefined) => {
    setFilter(next);
    const { pathname, search } = appHistory().location();
    const params = new URLSearchParams(search);
    if (next === undefined) params.delete("status");
    else params.set("status", next);
    const query = params.toString();
    appHistory().replace(
      `${pathname}${query === "" ? "" : `?${query}`}`,
      appHistory().state(),
    );
  };
  const visible =
    filter === undefined
      ? tasks
      : tasks.filter((task) => task.status === filter);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
        <h1 className="font-bold text-2xl">タスク一覧</h1>
        <nav aria-label="状態で絞り込む" className="flex flex-wrap gap-1">
          {[undefined, ...TASK_STATUS_ORDER].map((status) => (
            <Button
              key={status ?? "all"}
              size="sm"
              variant={filter === status ? "secondary" : "ghost"}
              aria-pressed={filter === status}
              onClick={() => choose(status)}
            >
              {status === undefined ? "すべて" : TASK_STATUS_LABELS[status]}
              <span className="text-muted-foreground text-xs">
                {status === undefined
                  ? tasks.length
                  : tasks.filter((p) => p.status === status).length}
              </span>
            </Button>
          ))}
        </nav>
        {visible.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {tasks.length === 0
              ? "まだタスクがありません。サイドバーから作成できます。"
              : "この状態のタスクはありません。"}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground text-xs">
              <tr className="border-b">
                <th className="py-2 pr-3 font-normal">名前</th>
                <th className="py-2 pr-3 font-normal">状態</th>
                <th className="py-2 pr-3 font-normal">次にやること</th>
                <th className="py-2 font-normal">進捗の最終更新</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => (
                <tr key={task.id} className="border-b align-top">
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      className="text-left font-medium text-primary hover:underline"
                      onClick={() => onOpen(task.id)}
                    >
                      {task.name}
                    </button>
                  </td>
                  <td className="py-2 pr-3">
                    <TaskStatusBadge status={task.status} />
                  </td>
                  <td className="py-2 pr-3">
                    {task.nextAction === "" ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      task.nextAction
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2 text-muted-foreground">
                    {formatDateTime(task.progressUpdatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
