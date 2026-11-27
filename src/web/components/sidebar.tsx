import {
  BookOpen,
  Boxes,
  Check,
  ChevronRight,
  FileText,
  Filter,
  FolderMinus,
  FolderPlus,
  FolderTree,
  GitBranch,
  LayoutDashboard,
  LayoutList,
  ListPlus,
  MessageSquarePlus,
  MessagesSquare,
  PackagePlus,
  Pencil,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { TaskStatus } from "../../db/schema.ts";
import type {
  ChatDto,
  EnvironmentDto,
  TaskDto,
  WikiDto,
} from "../../router.ts";
import { type ChatGroup, groupChats } from "../lib/groups.ts";
import {
  filterTasksByStatus,
  loadStatusFilter,
  saveStatusFilter,
  TASK_STATUS_CLASSES,
  TASK_STATUS_LABELS,
  TASK_STATUS_ORDER,
} from "../lib/task-status.ts";
import { cn } from "../lib/utils.ts";
import { ChatStatusBadge } from "./chat-status-badge.tsx";
import {
  type EnvironmentDialog,
  EnvironmentDialogs,
  type EnvironmentInput,
} from "./environment-dialogs.tsx";
import {
  SearchBox,
  type SearchResult,
  SearchResults,
  useSearch,
} from "./search-results.tsx";
import {
  AddThreadsDialog,
  type TaskDialog,
  TaskDialogs,
} from "./task-dialogs.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogFooter } from "./ui/dialog.tsx";
import { DropdownMenu } from "./ui/dropdown-menu.tsx";

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
  /** スレッド内の会話の数（2 以上なら表示する）。 */
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
  const label = chat.title === "" ? "新しいスレッド" : chat.title;

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
          aria-label="スレッドの名前"
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
        {chat.wikiPageId !== null && (
          // どのノートかは、スレッドを開くとチャットの先頭に出す
          <span
            className="shrink-0 text-muted-foreground"
            title="ノートから質問したスレッド"
          >
            <BookOpen aria-hidden className="size-3.5" />
          </span>
        )}
        <span className="truncate">{label}</span>
        {branchCount > 1 && (
          <span
            className="shrink-0 text-muted-foreground text-xs"
            title={`${branchCount} 個の会話`}
          >
            <GitBranch className="inline size-3" />
            {branchCount}
          </span>
        )}
        <ChatStatusBadge status={chat.status} />
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

// 改名前（#188）のキーのまま使い、ブラウザに保存した値を引き継ぐ
const EXPANDED_KEY = "cc-manabu.sidebarExpanded";

/**
 * 行（`env:<id>` / `task:<id>` / `unassigned`）を開閉した記録。ブラウザに覚える。
 * 記録の無い行は、環境と未所属は開き、タスクは閉じる。
 */
type Expanded = Record<string, boolean>;

const loadExpanded = (): Expanded => {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(EXPANDED_KEY) ?? "{}",
    );
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, boolean] =>
              typeof entry[1] === "boolean",
          ),
        )
      : {};
  } catch {
    return {};
  }
};

const saveExpanded = (expanded: Expanded) => {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded));
  } catch {
    // 覚えられなくても開閉はできる
  }
};

// 改名前（#188）のキーのまま使い、ブラウザに保存した値を引き継ぐ
const GROUP_KEY = "cc-manabu.sidebarGroupByEnvironment";

/** タスクを環境ごとにまとめるか（ブラウザに覚える。既定はまとめる）。 */
const loadGroupByEnvironment = (): boolean => {
  try {
    return localStorage.getItem(GROUP_KEY) !== "0";
  } catch {
    return true;
  }
};

const saveGroupByEnvironment = (value: boolean) => {
  try {
    localStorage.setItem(GROUP_KEY, value ? "1" : "0");
  } catch {
    // 覚えられなくても切り替えはできる
  }
};

const isExpanded = (expanded: Expanded, key: string): boolean =>
  expanded[key] ?? !key.startsWith("task:");

/**
 * スレッドの行の字下げ。親の行（環境・タスク・未所属）の名前の位置にそろえる
 * （親の字下げ＋開閉の矢印とアイコンの幅。行の内側の余白 extra を足す）。
 */
const threadIndent = (level: number, extra = 0): string =>
  `${0.25 + (level - 1) * 0.75 + 1.75 + extra}rem`;

/** 行の右端に出す操作（ホバー・フォーカス中だけ表示）。 */
const RowAction = ({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) => (
  <Button
    variant="ghost"
    size="icon"
    className="size-6"
    aria-label={label}
    title={label}
    onClick={onClick}
  >
    {children}
  </Button>
);

/** 開閉できる行（環境・タスク・未所属）。行を押すと開閉する。 */
const TreeRow = ({
  level,
  expanded,
  onToggle,
  icon,
  label,
  badge,
  selected = false,
  actions,
}: {
  level: number;
  expanded: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;
  badge?: ReactNode;
  selected?: boolean;
  actions?: ReactNode;
}) => (
  <div
    className={cn(
      "group flex items-center gap-1 rounded-md py-1 pr-1 text-sm hover:bg-sidebar-accent",
      selected && "bg-sidebar-accent",
    )}
    style={{ paddingLeft: `${0.25 + level * 0.75}rem` }}
  >
    <button
      type="button"
      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <ChevronRight
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          expanded && "rotate-90",
        )}
      />
      <span
        aria-hidden
        className="shrink-0 text-muted-foreground [&_svg]:size-3.5"
      >
        {icon}
      </span>
      <span className={cn("truncate", selected && "font-medium")}>{label}</span>
      {badge}
    </button>
    {actions !== undefined && (
      <div className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
        {actions}
      </div>
    )}
  </div>
);

/**
 * 左パネルのタスクを進捗で絞り込む（複数選択。#195）。
 * 「フィルタ」ボタンから開くメニューにまとめ、選んでも閉じずに続けて選べる（#208）。
 */
const StatusFilter = ({
  selected,
  onToggle,
}: {
  selected: readonly TaskStatus[];
  onToggle: (status: TaskStatus) => void;
}) => {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const count = TASK_STATUS_ORDER.length;

  const focusItem = (index: number) => {
    itemRefs.current[((index % count) + count) % count]?.focus();
  };
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    // メニューの外を押したら閉じる
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent) => {
    const current = itemRefs.current.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(current + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(current - 1);
        break;
      case "Home":
        event.preventDefault();
        focusItem(0);
        break;
      case "End":
        event.preventDefault();
        focusItem(count - 1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  const label =
    selected.length === 0
      ? "フィルタ"
      : `フィルタ（${selected.map((s) => TASK_STATUS_LABELS[s]).join("・")}）`;

  return (
    <div ref={rootRef} className="relative px-2 pb-2">
      <Button
        ref={triggerRef}
        variant={selected.length > 0 ? "secondary" : "ghost"}
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Filter />
        フィルタ
        {selected.length > 0 && (
          <span
            className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground leading-4"
            aria-hidden="true"
          >
            {selected.length}
          </span>
        )}
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="進捗で絞り込む"
          tabIndex={-1}
          className="absolute top-full left-2 z-50 mt-1 flex min-w-40 flex-col rounded-md border bg-background p-1 shadow-md"
          onKeyDown={onMenuKeyDown}
        >
          {TASK_STATUS_ORDER.map((status, index) => {
            const checked = selected.includes(status);
            return (
              <button
                key={status}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                tabIndex={-1}
                className="flex items-center gap-2 whitespace-nowrap rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus:bg-accent"
                // 選んでもメニューは閉じず、続けて選び直せる
                onClick={() => onToggle(status)}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {checked && <Check className="size-4" />}
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs",
                    TASK_STATUS_CLASSES[status],
                  )}
                >
                  {TASK_STATUS_LABELS[status]}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const Sidebar = ({
  id,
  hidden = false,
  width,
  chats,
  tasks,
  environments,
  wikis,
  defaultDirectory,
  taskId,
  selectedId,
  openTaskId,
  openWikiTaskId,
  onNewInTask,
  onSelect,
  onRename,
  onDelete,
  onOpenTask,
  onOpenWiki,
  onCreateTask,
  onCreateEnvironment,
  onUpdateEnvironment,
  onDeleteEnvironment,
  onPickDirectory,
  onRenameWiki,
  onRenameTask,
  onDeleteTask,
  onSetTask,
  onSetAutoTerms,
  onSetTaskEnvironment,
  onOpenTaskList,
  onOpenGeneralSettings,
  onSearch,
  onOpenSearchHit,
}: {
  id?: string;
  /** 畳んでいるか（⌘B）。畳んでも状態（検索・開閉）は保つ。 */
  hidden?: boolean;
  /** 幅（px、#185）。省略すると既定の幅。 */
  width?: number;
  /** すべての会話。 */
  chats: ChatDto[];
  tasks: TaskDto[];
  /** 環境。サイドバーでは環境 → タスク → スレッドの順に入れ子にする。 */
  environments: EnvironmentDto[];
  /** Wiki（環境の設定で選ぶ）。 */
  wikis: WikiDto[];
  /** 新しい環境に最初から入れておくディレクトリ（起動したディレクトリ）。 */
  defaultDirectory: string | undefined;
  /** いま開いている会話・画面の所属先のタスク（null は未所属）。 */
  taskId: string | null;
  selectedId: string | undefined;
  /** メインに概要を出しているタスク。 */
  openTaskId: string | undefined;
  /** メインに Wiki を出しているタスク（その環境の行を強調する）。 */
  openWikiTaskId: string | undefined;
  /** タスク（null は未所属）に新しいスレッドを作る。 */
  onNewInTask: (taskId: string | null) => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** タスクの概要を開く。 */
  onOpenTask: (taskId: string) => void;
  /** タスクの Wiki（ページ一覧）を開く。 */
  onOpenWiki: (taskId: string) => void;
  /** environmentId を渡すとその環境に、無ければ同じ名前の環境を新しく作って入れる。 */
  onCreateTask: (name: string, environmentId?: string) => Promise<void>;
  onCreateEnvironment: (input: EnvironmentInput) => Promise<void>;
  onUpdateEnvironment: (
    environmentId: string,
    input: EnvironmentInput,
  ) => Promise<void>;
  onDeleteEnvironment: (environmentId: string) => Promise<void>;
  /** OS のフォルダを選ぶダイアログを開く（キャンセルなら null）。 */
  onPickDirectory: () => Promise<string | null>;
  onRenameWiki: (wikiId: string, name: string) => Promise<void>;
  onRenameTask: (taskId: string, name: string) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
  /** スレッドの所属を変える（null で未所属に戻す）。 */
  onSetTask: (chatId: string, taskId: string | null) => Promise<void>;
  onSetAutoTerms: (taskId: string, enabled: boolean) => Promise<void>;
  onSetTaskEnvironment: (
    taskId: string,
    environmentId: string,
  ) => Promise<void>;
  onOpenTaskList: () => void;
  /** 設定の「一般」を開く（#170）。 */
  onOpenGeneralSettings: () => void;
  /** スレッドを検索する（#115）。 */
  onSearch: (q: string) => Promise<SearchResult>;
  /** 検索結果を開く。messageId があればその発言へ移動する。 */
  onOpenSearchHit: (chatId: string, messageId?: string) => void;
}) => {
  const [deleting, setDeleting] = useState<ChatDto>();
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const search = useSearch(query, onSearch);
  const [searchOpen, setSearchOpen] = useState(false);
  const [groupByEnvironment, setGroupByEnvironment] = useState(
    loadGroupByEnvironment,
  );
  // 進捗の絞り込み（#195）。何も選んでいなければすべてのタスクを出す
  const [statusFilter, setStatusFilter] =
    useState<TaskStatus[]>(loadStatusFilter);
  const toggleStatus = (status: TaskStatus) => {
    const next = TASK_STATUS_ORDER.filter((s) =>
      s === status ? !statusFilter.includes(s) : statusFilter.includes(s),
    );
    setStatusFilter(next);
    saveStatusFilter(next);
  };
  const visibleTasks = filterTasksByStatus(tasks, statusFilter);
  const searchId = useId();
  const searchButton = useRef<HTMLButtonElement>(null);
  const closeSearch = (restoreFocus: boolean) => {
    setQuery("");
    setSearchOpen(false);
    if (restoreFocus) searchButton.current?.focus();
  };
  /** 既存のスレッドを追加する先のタスク。 */
  const [addingTo, setAddingTo] = useState<TaskDto>();
  const [taskDialog, setTaskDialog] = useState<TaskDialog>();
  const [environmentDialog, setEnvironmentDialog] =
    useState<EnvironmentDialog>();
  // 会話はスレッドごとに 1 行にまとめる（#76）
  const groups = groupChats(chats);
  const task = tasks.find((p) => p.id === taskId);

  const [expanded, setExpanded] = useState<Expanded>(loadExpanded);
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = { ...current, [key]: !isExpanded(current, key) };
      saveExpanded(next);
      return next;
    });
  // 開いた会話・タスクが見えるように、その親を開く
  const environmentOfTask = task?.environmentId ?? undefined;
  useEffect(() => {
    const keys =
      taskId === null
        ? selectedId === undefined
          ? []
          : ["unassigned"]
        : [
            `task:${taskId}`,
            ...(environmentOfTask === undefined
              ? []
              : [`env:${environmentOfTask}`]),
          ];
    setExpanded((current) => {
      if (keys.every((key) => isExpanded(current, key))) return current;
      const next = { ...current };
      for (const key of keys) next[key] = true;
      saveExpanded(next);
      return next;
    });
  }, [taskId, environmentOfTask, selectedId]);

  const threadsOf = (owner: string | null) =>
    groups.filter((group) => group.primary.taskId === owner);

  const renderThreads = (
    items: ChatGroup[],
    level: number,
    owner: TaskDto | undefined,
  ) =>
    items.length === 0 ? (
      <p
        className="py-1 text-muted-foreground text-xs"
        style={{ paddingLeft: threadIndent(level, 0.5) }}
      >
        {owner === undefined
          ? "未所属のスレッドはありません。"
          : "まだスレッドがありません。"}
      </p>
    ) : (
      <ul className="flex flex-col gap-0.5">
        {items.map(({ groupId, primary, branches, status }) => (
          <li key={groupId} style={{ paddingLeft: threadIndent(level) }}>
            <ChatItem
              chat={{ ...primary, status }}
              branchCount={branches.length}
              selected={branches.some((chat) => chat.id === selectedId)}
              onSelect={() => onSelect(primary.id)}
              onRename={(title) => onRename(primary.id, title)}
              onDelete={() => setDeleting(primary)}
              {...(owner === undefined || primary.wikiPageId !== null
                ? {}
                : {
                    onRemoveFromTask: () => void onSetTask(primary.id, null),
                  })}
            />
          </li>
        ))}
      </ul>
    );

  const renderTask = (item: TaskDto, level: number) => {
    const key = `task:${item.id}`;
    const open = isExpanded(expanded, key);
    return (
      <li key={item.id} data-task-id={item.id}>
        <TreeRow
          level={level}
          expanded={open}
          onToggle={() => toggle(key)}
          icon={<LayoutDashboard />}
          label={item.name}
          selected={openTaskId === item.id}
          {...(item.status === "done"
            ? {
                badge: (
                  <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                    完了
                  </span>
                ),
              }
            : {})}
          actions={
            <>
              <RowAction
                label={`「${item.name}」の概要を開く`}
                onClick={() => onOpenTask(item.id)}
              >
                <FileText className="size-3.5" />
              </RowAction>
              <RowAction
                label={`「${item.name}」に新しいスレッド`}
                onClick={() => onNewInTask(item.id)}
              >
                <MessageSquarePlus className="size-3.5" />
              </RowAction>
              <DropdownMenu
                label={`「${item.name}」のメニュー`}
                triggerClassName="size-6"
                icon={<Settings className="size-3.5" />}
                items={[
                  {
                    label: "既存のスレッドを追加",
                    icon: <ListPlus />,
                    onSelect: () => setAddingTo(item),
                  },
                  {
                    label: "タスクの設定",
                    icon: <SlidersHorizontal />,
                    onSelect: () =>
                      setTaskDialog({ kind: "settings", taskId: item.id }),
                    separatorBefore: true,
                  },
                  {
                    label: "タスクの名前を変える",
                    icon: <Pencil />,
                    onSelect: () =>
                      setTaskDialog({ kind: "rename", taskId: item.id }),
                  },
                  {
                    label: "タスクを削除",
                    icon: <Trash2 />,
                    onSelect: () =>
                      setTaskDialog({ kind: "delete", taskId: item.id }),
                    variant: "destructive",
                  },
                ]}
              />
            </>
          }
        />
        {open && renderThreads(threadsOf(item.id), level + 1, item)}
      </li>
    );
  };

  const openWikiEnvironmentId = tasks.find(
    (p) => p.id === openWikiTaskId,
  )?.environmentId;
  const orphans = tasks.filter(
    (p) =>
      !environments.some((environment) => environment.id === p.environmentId),
  );
  const unassignedOpen = isExpanded(expanded, "unassigned");

  return (
    <aside
      id={id}
      hidden={hidden}
      aria-label="サイドバー"
      className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground [&[hidden]]:hidden"
      style={width === undefined ? undefined : { width }}
    >
      <div className="flex items-center p-2">
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
            aria-label="新しいタスク"
            title="新しいタスク"
            onClick={() => setTaskDialog({ kind: "create" })}
          >
            <FolderPlus />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="新しい環境"
            title="新しい環境"
            onClick={() => setEnvironmentDialog({ kind: "create" })}
          >
            <PackagePlus />
          </Button>
          <Button
            variant={groupByEnvironment ? "secondary" : "ghost"}
            size="icon"
            aria-label="環境ごとにまとめる"
            title={
              groupByEnvironment
                ? "環境ごとにまとめる（オン）"
                : "環境ごとにまとめる（オフ）"
            }
            aria-pressed={groupByEnvironment}
            onClick={() => {
              setGroupByEnvironment(!groupByEnvironment);
              saveGroupByEnvironment(!groupByEnvironment);
            }}
          >
            <FolderTree />
          </Button>
          <Button
            ref={searchButton}
            variant={searchOpen ? "secondary" : "ghost"}
            size="icon"
            aria-label="スレッドを検索"
            title="スレッドを検索"
            aria-expanded={searchOpen}
            aria-controls={searchOpen ? searchId : undefined}
            // 開いているときは、押しても検索欄からフォーカスを外さない（外れると先に閉じてしまう）
            onMouseDown={(event) => {
              if (searchOpen) event.preventDefault();
            }}
            onClick={() =>
              searchOpen ? closeSearch(false) : setSearchOpen(true)
            }
          >
            <Search />
          </Button>
          <DropdownMenu
            label="設定"
            icon={<Settings />}
            triggerClassName="size-9"
            items={[
              {
                label: "一般",
                icon: <SlidersHorizontal />,
                onSelect: onOpenGeneralSettings,
              },
            ]}
          />
        </div>
      </div>
      {searchOpen && (
        <SearchBox
          id={searchId}
          value={query}
          onChange={setQuery}
          onClose={closeSearch}
        />
      )}
      {searching ? (
        <nav
          className="flex-1 overflow-y-auto px-2 pb-2"
          aria-label="スレッドの検索結果"
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
          <StatusFilter selected={statusFilter} onToggle={toggleStatus} />
          <nav
            className="flex-1 overflow-y-auto px-2 pb-2"
            aria-label="スレッド一覧"
          >
            <ul className="flex flex-col gap-0.5">
              {!groupByEnvironment &&
                visibleTasks.map((item) => renderTask(item, 0))}
              {groupByEnvironment &&
                environments.map((environment) => {
                  const key = `env:${environment.id}`;
                  const open = isExpanded(expanded, key);
                  const first = tasks.find(
                    (p) => p.environmentId === environment.id,
                  );
                  const members = visibleTasks.filter(
                    (p) => p.environmentId === environment.id,
                  );
                  // 絞り込み中は、当てはまるタスクの無い環境を出さない
                  if (statusFilter.length > 0 && members.length === 0) {
                    return null;
                  }
                  return (
                    <li
                      key={environment.id}
                      data-environment-id={environment.id}
                    >
                      <TreeRow
                        level={0}
                        expanded={open}
                        onToggle={() => toggle(key)}
                        icon={<Boxes />}
                        label={environment.name}
                        selected={openWikiEnvironmentId === environment.id}
                        actions={
                          <>
                            {first !== undefined &&
                              environment.wikiId !== null && (
                                <RowAction
                                  label={`環境「${environment.name}」の Wiki を開く`}
                                  onClick={() => onOpenWiki(first.id)}
                                >
                                  <BookOpen className="size-3.5" />
                                </RowAction>
                              )}
                            <RowAction
                              label={`環境「${environment.name}」に新しいタスク`}
                              onClick={() =>
                                setTaskDialog({
                                  kind: "create",
                                  environmentId: environment.id,
                                })
                              }
                            >
                              <FolderPlus className="size-3.5" />
                            </RowAction>
                            <DropdownMenu
                              label={`環境「${environment.name}」のメニュー`}
                              triggerClassName="size-6"
                              icon={<Settings className="size-3.5" />}
                              items={[
                                {
                                  label: "環境の設定",
                                  icon: <SlidersHorizontal />,
                                  onSelect: () =>
                                    setEnvironmentDialog({
                                      kind: "settings",
                                      environmentId: environment.id,
                                    }),
                                },
                                {
                                  label: "環境を削除",
                                  icon: <Trash2 />,
                                  onSelect: () =>
                                    setEnvironmentDialog({
                                      kind: "delete",
                                      environmentId: environment.id,
                                    }),
                                  variant: "destructive",
                                },
                              ]}
                            />
                          </>
                        }
                      />
                      {open &&
                        (members.length === 0 ? (
                          <p
                            className="py-1 text-muted-foreground text-xs"
                            style={{ paddingLeft: threadIndent(1, 0.5) }}
                          >
                            まだタスクがありません。
                          </p>
                        ) : (
                          <ul className="flex flex-col gap-0.5">
                            {members.map((member) => renderTask(member, 1))}
                          </ul>
                        ))}
                    </li>
                  );
                })}
              {groupByEnvironment &&
                orphans.map((orphan) => renderTask(orphan, 0))}
              <li data-unassigned>
                <TreeRow
                  level={0}
                  expanded={unassignedOpen}
                  onToggle={() => toggle("unassigned")}
                  icon={<MessagesSquare />}
                  label="未所属のスレッド"
                  actions={
                    <RowAction
                      label="未所属に新しいスレッド"
                      onClick={() => onNewInTask(null)}
                    >
                      <MessageSquarePlus className="size-3.5" />
                    </RowAction>
                  }
                />
                {unassignedOpen && renderThreads(threadsOf(null), 1, undefined)}
              </li>
            </ul>
          </nav>
        </>
      )}
      <TaskDialogs
        dialog={taskDialog}
        onClose={() => setTaskDialog(undefined)}
        tasks={tasks}
        environments={environments}
        onCreate={onCreateTask}
        onRename={onRenameTask}
        onDelete={onDeleteTask}
        onSetAutoTerms={onSetAutoTerms}
        onSetEnvironment={onSetTaskEnvironment}
      />
      <EnvironmentDialogs
        dialog={environmentDialog}
        onClose={() => setEnvironmentDialog(undefined)}
        environments={environments}
        wikis={wikis}
        defaultDirectory={defaultDirectory}
        onCreate={onCreateEnvironment}
        onUpdate={onUpdateEnvironment}
        onRenameWiki={onRenameWiki}
        onDelete={onDeleteEnvironment}
        onPickDirectory={onPickDirectory}
      />
      <AddThreadsDialog
        open={addingTo !== undefined}
        taskName={addingTo?.name ?? ""}
        candidates={groups
          .filter(
            (group) =>
              group.primary.taskId === null &&
              group.primary.wikiPageId === null,
          )
          .map((group) => group.primary)}
        onAdd={async (chatId) => {
          if (addingTo !== undefined) await onSetTask(chatId, addingTo.id);
        }}
        onClose={() => setAddingTo(undefined)}
      />
      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title="スレッドを削除しますか？"
        description={`「${deleting?.title || "新しいスレッド"}」を、すべての会話ごと削除します。この操作は取り消せません。${deleting?.status === "running" ? "生成中の回答は止まります。" : ""}`}
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
