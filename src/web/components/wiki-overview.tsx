import { ChevronRight, Info } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogFooter } from "./ui/dialog.tsx";

/** この Wiki を参照しているタスク。 */
export type WikiReferencingTask = { id: string; name: string };

/**
 * 画面上部のヘッダーの「Wiki の概要」（#213）。
 * 参照しているタスクの件数（押すと一覧）と、回答からの用語ノートの自動作成の設定を出す。
 */
export const WikiOverviewButton = ({
  wikiName,
  tasks,
  autoTerms,
  onOpenTask,
}: {
  wikiName: string;
  /** この Wiki を参照しているタスク（開いているタスクを含む）。 */
  tasks: readonly WikiReferencingTask[];
  /** 回答からの用語ノートの自動作成が有効か（開いているタスクの設定）。 */
  autoTerms: boolean;
  onOpenTask: (taskId: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-haspopup="dialog"
        onClick={() => {
          setTasksOpen(false);
          setOpen(true);
        }}
      >
        <Info className="size-3.5" />
        <span className="max-md:sr-only">Wiki の概要</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Wiki の概要"
        description={`Wiki: ${wikiName}`}
      >
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <button
              type="button"
              className="inline-flex items-center gap-1 self-start text-left text-primary underline-offset-2 hover:underline"
              aria-expanded={tasksOpen}
              aria-controls="wiki-overview-tasks"
              onClick={() => setTasksOpen(!tasksOpen)}
            >
              <ChevronRight
                className={cn(
                  "size-4 transition-transform",
                  tasksOpen && "rotate-90",
                )}
                aria-hidden
              />
              {tasks.length}件の参照しているタスクがあります
            </button>
            {tasksOpen && (
              <ul
                id="wiki-overview-tasks"
                aria-label="この Wiki を参照しているタスク"
                className="ml-5 flex flex-col gap-0.5"
              >
                {tasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      className="w-full truncate rounded-md px-2 py-1 text-left hover:bg-accent"
                      onClick={() => {
                        setOpen(false);
                        onOpenTask(task.id);
                      }}
                    >
                      {task.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {tasks.length > 1 && (
              <p className="text-muted-foreground text-xs">
                ノートの変更は、参照しているすべてのタスクに反映されます。
              </p>
            )}
          </div>
          <p>
            回答からの用語ノートの自動作成: {autoTerms ? "オン" : "オフ"}
            <span className="text-muted-foreground">
              （タスクの設定で変更できます）
            </span>
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            閉じる
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
};
