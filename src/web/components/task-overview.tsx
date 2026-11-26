import { BookOpen, MessageSquare } from "lucide-react";
import type { ChatDto, TaskDto } from "../../router.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { TaskLinks } from "./task-links.tsx";
import { TaskProgress } from "./task-progress.tsx";
import { Button } from "./ui/button.tsx";

/** タスク画面（`/t/<id>`）。スレッド・Wiki への入口と関連リンク。 */
export const TaskOverview = ({
  api,
  task,
  threads,
  onOpenChat,
  onOpenWiki,
  onNewChat,
  onChanged,
}: {
  api: ApiClient;
  task: TaskDto;
  /** 進捗を保存したあと、タスクを取り直す。 */
  onChanged: () => Promise<void>;
  /** このタスクのスレッド（更新日時の新しい順）。 */
  threads: ChatDto[];
  onOpenChat: (chatId: string) => void;
  onOpenWiki: () => void;
  onNewChat: () => void;
}) => (
  <div className="flex-1 overflow-y-auto">
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-6">
      <header className="flex flex-col gap-3">
        <h1 className="font-bold text-2xl">{task.name}</h1>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onNewChat}>
            <MessageSquare className="size-4" />
            新しいスレッド
          </Button>
          <Button size="sm" variant="outline" onClick={onOpenWiki}>
            <BookOpen className="size-4" />
            Wiki を開く
          </Button>
        </div>
      </header>

      <TaskProgress api={api} task={task} onChanged={onChanged} />

      <TaskLinks key={task.id} api={api} taskId={task.id} />

      <section aria-labelledby="task-threads" className="flex flex-col gap-3">
        <h2
          id="task-threads"
          className="flex items-center gap-2 font-semibold text-base"
        >
          <MessageSquare className="size-4" />
          最近のスレッド
        </h2>
        {threads.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            まだスレッドがありません。
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {threads.slice(0, 5).map((chat) => (
              <li key={chat.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => onOpenChat(chat.id)}
                >
                  <span className="truncate">
                    {chat.title === "" ? "新しいスレッド" : chat.title}
                  </span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {new Date(chat.updatedAt).toLocaleString("ja-JP")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  </div>
);
