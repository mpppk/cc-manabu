import { ArchiveRestore, BookOpen, MessageSquare } from "lucide-react";
import { useState } from "react";
import type { ChatDto, TaskDto } from "../../router.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { formatDateTime } from "../lib/task-status.ts";
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
  onRestore,
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
  /** アーカイブしたタスクを復元する（#241）。失敗したら reject する。 */
  onRestore: () => Promise<void>;
}) => (
  <div className="flex-1 overflow-y-auto">
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-6">
      {task.archivedAt !== null && (
        <ArchivedNotice archivedAt={task.archivedAt} onRestore={onRestore} />
      )}
      <header className="flex flex-col gap-3">
        <h1 className="font-bold text-2xl">{task.name}</h1>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onNewChat}>
            <MessageSquare className="size-4" />
            新しいスレッド
          </Button>
          {/* Wiki を使わない環境のタスクには出さない（#232） */}
          {task.wikiId !== null && (
            <Button size="sm" variant="outline" onClick={onOpenWiki}>
              <BookOpen className="size-4" />
              Wiki を開く
            </Button>
          )}
        </div>
      </header>

      <TaskProgress
        api={api}
        task={task}
        onChanged={onChanged}
        onOpenChat={onOpenChat}
      />

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

/** アーカイブしたタスクの概要に出す案内と「復元」（#241）。 */
const ArchivedNotice = ({
  archivedAt,
  onRestore,
}: {
  archivedAt: Date | string;
  onRestore: () => Promise<void>;
}) => {
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <section
      aria-label="アーカイブ済み"
      className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          このタスクはアーカイブ済みです（{formatDateTime(archivedAt)}
          ）。サイドバーとタスク一覧には表示されません。
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={restoring}
          onClick={() => {
            setRestoring(true);
            setError(undefined);
            onRestore()
              .catch((cause: unknown) =>
                setError(
                  `復元できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
                ),
              )
              .finally(() => setRestoring(false));
          }}
        >
          <ArchiveRestore className="size-4" />
          復元
        </Button>
      </div>
      {error !== undefined && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
};
