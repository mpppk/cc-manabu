import { BookOpen, MessageSquare } from "lucide-react";
import type { ChatDto, ProjectDto } from "../../router.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { ProjectLinks } from "./project-links.tsx";
import { ProjectProgress } from "./project-progress.tsx";
import { Button } from "./ui/button.tsx";

/** プロジェクト画面（`/p/<id>`）。スレッド・Wiki への入口と関連リンク。 */
export const ProjectOverview = ({
  api,
  project,
  threads,
  onOpenChat,
  onOpenWiki,
  onNewChat,
  onChanged,
}: {
  api: ApiClient;
  project: ProjectDto;
  /** 進捗を保存したあと、プロジェクトを取り直す。 */
  onChanged: () => Promise<void>;
  /** このプロジェクトのスレッド（更新日時の新しい順）。 */
  threads: ChatDto[];
  onOpenChat: (chatId: string) => void;
  onOpenWiki: () => void;
  onNewChat: () => void;
}) => (
  <div className="flex-1 overflow-y-auto">
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-6">
      <header className="flex flex-col gap-3">
        <h1 className="font-bold text-2xl">{project.name}</h1>
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

      <ProjectProgress api={api} project={project} onChanged={onChanged} />

      <ProjectLinks key={project.id} api={api} projectId={project.id} />

      <section
        aria-labelledby="project-threads"
        className="flex flex-col gap-3"
      >
        <h2
          id="project-threads"
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
                    {chat.title === "" ? "新しい会話" : chat.title}
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
