import { useState } from "react";
import type { TaskStatus } from "../../db/schema.ts";
import type { TaskDto } from "../../router.ts";
import {
  formatDateTime,
  isTaskStatus,
  TASK_STATUS_CLASSES,
  TASK_STATUS_LABELS,
  TASK_STATUS_ORDER,
} from "../lib/task-status.ts";
import { cn } from "../lib/utils.ts";

const DRAG_TYPE = "application/x-monet-task";

/**
 * タスク一覧（`/tasks`）。進捗の状態ごとの列に並べるカンバン（#195）。
 * カードを別の列へドラッグ＆ドロップするか、カードの「状態」で選ぶと、その状態を保存する。
 * 保存に失敗したら元の列に戻し、理由を出す。
 */
export const TaskList = ({
  tasks,
  onOpen,
  onMove,
}: {
  tasks: TaskDto[];
  onOpen: (taskId: string) => void;
  /** 状態を保存する（保存後の一覧の取り直しまで）。失敗したら reject する。 */
  onMove: (taskId: string, status: TaskStatus) => Promise<void>;
}) => {
  /** 保存中の移動。保存が終わるまで、移動先の列に出しておく。 */
  const [moving, setMoving] = useState<Record<string, TaskStatus>>({});
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState<string>();
  const [dropTarget, setDropTarget] = useState<TaskStatus>();

  const statusOf = (task: TaskDto): TaskStatus =>
    moving[task.id] ?? task.status;

  const move = (task: TaskDto, status: TaskStatus) => {
    if (statusOf(task) === status) return;
    setError(undefined);
    setMoving((prev) => ({ ...prev, [task.id]: status }));
    onMove(task.id, status)
      .catch((cause: unknown) => {
        setError(
          `「${task.name}」を「${TASK_STATUS_LABELS[status]}」にできませんでした: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      })
      .finally(() => {
        setMoving(({ [task.id]: _, ...rest }) => rest);
      });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6">
        <h1 className="font-bold text-2xl">タスク一覧</h1>
        {error !== undefined && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {tasks.length === 0 && (
          <p className="text-muted-foreground text-sm">
            まだタスクがありません。サイドバーから作成できます。
          </p>
        )}
        <div className="overflow-x-auto pb-2">
          <div className="grid min-w-[60rem] grid-cols-5 gap-3">
            {TASK_STATUS_ORDER.map((status) => {
              const column = tasks.filter((task) => statusOf(task) === status);
              const headingId = `task-column-${status}`;
              return (
                <section
                  key={status}
                  aria-labelledby={headingId}
                  data-status={status}
                  className={cn(
                    "flex min-h-48 flex-col gap-2 rounded-lg border bg-muted/30 p-2 transition-colors",
                    dropTarget === status && "border-ring bg-accent/60",
                  )}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDropTarget(status);
                  }}
                  onDragLeave={(event) => {
                    if (
                      !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                      )
                    ) {
                      setDropTarget(undefined);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDropTarget(undefined);
                    const id = event.dataTransfer.getData(DRAG_TYPE);
                    const task = tasks.find((t) => t.id === id);
                    if (task !== undefined) move(task, status);
                  }}
                >
                  <h2
                    id={headingId}
                    className="flex items-center gap-2 px-1 font-medium text-sm"
                  >
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs",
                        TASK_STATUS_CLASSES[status],
                      )}
                    >
                      {TASK_STATUS_LABELS[status]}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {column.length}
                    </span>
                  </h2>
                  {column.length === 0 ? (
                    <p className="px-1 py-4 text-center text-muted-foreground text-xs">
                      タスクはありません
                    </p>
                  ) : (
                    <ul
                      aria-label={`${TASK_STATUS_LABELS[status]}のタスク`}
                      className="flex flex-col gap-2"
                    >
                      {column.map((task) => (
                        <li
                          key={task.id}
                          data-task-card={task.id}
                          draggable
                          onDragStart={(event) => {
                            event.dataTransfer.setData(DRAG_TYPE, task.id);
                            event.dataTransfer.effectAllowed = "move";
                            setDragging(task.id);
                          }}
                          onDragEnd={() => {
                            setDragging(undefined);
                            setDropTarget(undefined);
                          }}
                          className={cn(
                            "flex cursor-grab flex-col gap-1.5 rounded-md border bg-background p-2 text-sm shadow-xs active:cursor-grabbing",
                            dragging === task.id && "opacity-50",
                            moving[task.id] !== undefined && "opacity-70",
                          )}
                        >
                          <button
                            type="button"
                            className="text-left font-medium text-primary hover:underline"
                            onClick={() => onOpen(task.id)}
                          >
                            {task.name}
                          </button>
                          <p className="whitespace-pre-wrap break-words text-xs">
                            {task.nextAction === "" ? (
                              <span className="text-muted-foreground">
                                ゴール: —
                              </span>
                            ) : (
                              <>
                                <span className="text-muted-foreground">
                                  ゴール:{" "}
                                </span>
                                {task.nextAction}
                              </>
                            )}
                          </p>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground text-xs">
                              最終更新: {formatDateTime(task.progressUpdatedAt)}
                            </span>
                            {/* ドラッグできない環境（キーボード・タッチ）でも状態を変えられるようにする */}
                            <select
                              className="h-6 rounded-sm border bg-background px-1 text-xs"
                              aria-label={`「${task.name}」の状態`}
                              value={statusOf(task)}
                              onChange={(event) => {
                                const next = event.target.value;
                                if (isTaskStatus(next)) move(task, next);
                              }}
                            >
                              {TASK_STATUS_ORDER.map((option) => (
                                <option key={option} value={option}>
                                  {TASK_STATUS_LABELS[option]}
                                </option>
                              ))}
                            </select>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
