import {
  BookOpen,
  Check,
  FolderMinus,
  GitBranch,
  LayoutList,
  ListPlus,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import type { ChatDto, TaskDto, WikiDto } from "../../router.ts";
import { groupChats } from "../lib/groups.ts";
import { cn } from "../lib/utils.ts";
import {
  SearchBox,
  type SearchResult,
  SearchResults,
  useSearch,
} from "./search-results.tsx";
import {
  AddThreadsDialog,
  GroupByWikiToggle,
  TaskSwitcher,
  useGroupByWiki,
} from "./task-switcher.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogFooter } from "./ui/dialog.tsx";

const StatusBadge = ({ status }: { status: ChatDto["status"] }) => {
  switch (status) {
    case "running":
      return (
        <Loader2
          className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          aria-label="生成中"
        />
      );
    case "awaiting_approval":
      return (
        <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
          承認待ち
        </span>
      );
    case "error":
      return (
        <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
          エラー
        </span>
      );
    default:
      return null;
  }
};

const ChatItem = ({
  chat,
  selected,
  onSelect,
  onRename,
  onDelete,
  onRemoveFromTask,
  branchCount = 1,
}: {
  chat: ChatDto;
  /** 会話の分岐の数（2 以上なら表示する）。 */
  branchCount?: number;
  selected: boolean;
  onSelect: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => void;
  /** タスク内の一覧なら、タスクから外せる。 */
  onRemoveFromTask?: () => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const label = chat.title === "" ? "新しい会話" : chat.title;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() !== "") {
      await onRename(title.trim());
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <form className="flex items-center gap-1 px-1 py-0.5" onSubmit={submit}>
        <input
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm"
          aria-label="会話の名前"
          value={title}
          // biome-ignore lint/a11y/noAutofocus: 名前の編集を始めた直後に入力できるようにする
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
          }}
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="保存"
        >
          <Check />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="キャンセル"
          onClick={() => setEditing(false)}
        >
          <X />
        </Button>
      </form>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent",
        selected && "bg-sidebar-accent font-medium",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
      >
        <span className="truncate">{label}</span>
        {branchCount > 1 && (
          <span
            className="shrink-0 text-muted-foreground text-xs"
            title={`${branchCount} 個の分岐`}
          >
            <GitBranch className="inline size-3" />
            {branchCount}
          </span>
        )}
        <StatusBadge status={chat.status} />
      </button>
      <div className="hidden shrink-0 group-hover:flex group-focus-within:flex">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`「${label}」の名前を変える`}
          onClick={() => {
            setTitle(chat.title);
            setEditing(true);
          }}
        >
          <Pencil className="size-3.5" />
        </Button>
        {onRemoveFromTask !== undefined && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={`「${label}」をタスクから外す`}
            title="タスクから外す"
            onClick={onRemoveFromTask}
          >
            <FolderMinus className="size-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`「${label}」を削除`}
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
};

export const Sidebar = ({
  chats,
  tasks,
  taskId,
  selectedId,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onSelectTask,
  onCreateTask,
  wikis,
  onRenameWiki,
  onRenameTask,
  onDeleteTask,
  onSetTask,
  view,
  onOpenWiki,
  wikiPanel,
  onSetAutoTerms,
  onOpenTaskList,
  onSearch,
  onOpenSearchHit,
}: {
  /** すべての会話（表示は選択中のタスクで絞る）。 */
  chats: ChatDto[];
  tasks: TaskDto[];
  /** 選択中のタスク。null は未所属の会話。 */
  taskId: string | null;
  selectedId: string | undefined;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSelectTask: (taskId: string | null) => void;
  /** wikiId を渡すとその Wiki を共有し、無ければ新しい Wiki を作る。 */
  onCreateTask: (name: string, wikiId?: string) => Promise<void>;
  /** Wiki（タスクで共有できる）。 */
  wikis: WikiDto[];
  onRenameWiki: (wikiId: string, name: string) => Promise<void>;
  onRenameTask: (taskId: string, name: string) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
  /** 会話の所属を変える（null で未所属に戻す）。 */
  onSetTask: (chatId: string, taskId: string | null) => Promise<void>;
  /** メイン画面に出しているもの（タスク選択時のタブの状態）。 */
  view: "threads" | "wiki";
  onOpenWiki: () => void;
  /** Wiki を表示しているとき、会話一覧の代わりに出すページ一覧。 */
  wikiPanel?: ReactNode;
  onSetAutoTerms: (taskId: string, enabled: boolean) => Promise<void>;
  onOpenTaskList: () => void;
  /** 会話を検索する（#115）。 */
  onSearch: (q: string) => Promise<SearchResult>;
  /** 検索結果を開く。messageId があればその発言へ移動する。 */
  onOpenSearchHit: (chatId: string, messageId?: string) => void;
}) => {
  const [deleting, setDeleting] = useState<ChatDto>();
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const search = useSearch(query, onSearch);
  const [adding, setAdding] = useState(false);
  // 分岐は会話ごとに 1 行にまとめる（#76）
  const groups = groupChats(chats);
  const visible = groups.filter((group) => group.primary.taskId === taskId);
  const task = tasks.find((p) => p.id === taskId);
  const showWikiPanel = task !== undefined && view === "wiki";
  const [searchOpen, setSearchOpen] = useState(false);
  const [groupByWiki, setGroupByWiki] = useGroupByWiki();

  const threadList =
    visible.length === 0 ? (
      <p className="px-2 py-4 text-muted-foreground text-sm">
        {task === undefined
          ? "未所属の会話はありません。"
          : "このタスクにはまだ会話がありません。"}
      </p>
    ) : (
      <ul className="flex flex-col gap-0.5">
        {visible.map(({ groupId, primary, branches, status }) => (
          <li key={groupId}>
            <ChatItem
              chat={{ ...primary, status }}
              branchCount={branches.length}
              selected={branches.some((chat) => chat.id === selectedId)}
              onSelect={() => onSelect(primary.id)}
              onRename={(title) => onRename(primary.id, title)}
              onDelete={() => setDeleting(primary)}
              {...(task === undefined
                ? {}
                : {
                    onRemoveFromTask: () => void onSetTask(primary.id, null),
                  })}
            />
          </li>
        ))}
      </ul>
    );

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between p-3">
        <span className="font-semibold">cc-manabu</span>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            aria-label="タスク一覧"
            title="タスク一覧"
            onClick={onOpenTaskList}
          >
            <LayoutList />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="新しい会話"
            title={
              task === undefined ? "新しい会話" : `「${task.name}」に新しい会話`
            }
            onClick={onNew}
          >
            <MessageSquarePlus />
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <TaskSwitcher
          tasks={tasks}
          taskId={taskId}
          onSelect={onSelectTask}
          onCreate={onCreateTask}
          wikis={wikis}
          onRenameWiki={onRenameWiki}
          onRename={onRenameTask}
          onDelete={onDeleteTask}
          onSetAutoTerms={onSetAutoTerms}
          groupByWiki={groupByWiki}
        />
        {task !== undefined && (
          <nav className="flex gap-1 px-3 pb-2" aria-label="タスクの表示">
            <Button
              variant={view === "threads" ? "secondary" : "ghost"}
              size="sm"
              className="flex-1"
              aria-pressed={view === "threads"}
              onClick={() => onSelectTask(task.id)}
            >
              スレッド
            </Button>
            <Button
              variant={view === "wiki" ? "secondary" : "ghost"}
              size="sm"
              className="flex-1"
              aria-pressed={view === "wiki"}
              onClick={onOpenWiki}
            >
              <BookOpen className="size-3.5" />
              Wiki
            </Button>
          </nav>
        )}
        {showWikiPanel ? (
          wikiPanel
        ) : (
          <>
            <div className="flex items-center gap-1 px-3 pb-2">
              <SearchBox
                value={query}
                onChange={setQuery}
                open={searchOpen}
                onOpenChange={setSearchOpen}
              />
              {task !== undefined && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-8"
                  aria-label="既存のスレッドを追加"
                  title="既存のスレッドを追加"
                  onClick={() => setAdding(true)}
                >
                  <ListPlus className="size-4" />
                </Button>
              )}
            </div>
            {searching ? (
              <nav
                className="flex-1 overflow-y-auto px-2 pb-2"
                aria-label="会話の検索結果"
              >
                <SearchResults
                  chats={chats}
                  query={query}
                  result={search.result}
                  error={search.error}
                  onOpen={onOpenSearchHit}
                />
              </nav>
            ) : (
              <>
                {tasks.length > 0 && (
                  <GroupByWikiToggle
                    checked={groupByWiki}
                    onChange={setGroupByWiki}
                  />
                )}
                <nav
                  className="flex-1 overflow-y-auto px-2 pb-2"
                  aria-label="会話一覧"
                >
                  {threadList}
                </nav>
              </>
            )}
          </>
        )}
      </div>
      <AddThreadsDialog
        open={adding}
        taskName={task?.name ?? ""}
        candidates={groups
          .filter((group) => group.primary.taskId === null)
          .map((group) => group.primary)}
        onAdd={async (chatId) => {
          if (task !== undefined) await onSetTask(chatId, task.id);
        }}
        onClose={() => setAdding(false)}
      />
      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title="会話を削除しますか？"
        description={`「${deleting?.title || "新しい会話"}」を、すべての分岐ごと削除します。この操作は取り消せません。${deleting?.status === "running" ? "生成中の応答は止まります。" : ""}`}
      >
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleting(undefined)}>
            キャンセル
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (deleting !== undefined) {
                await onDelete(deleting.id);
              }
              setDeleting(undefined);
            }}
          >
            削除
          </Button>
        </DialogFooter>
      </Dialog>
    </aside>
  );
};
