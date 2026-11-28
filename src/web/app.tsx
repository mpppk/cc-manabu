import {
  FolderPlus,
  LayoutList,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveChatDefaults } from "../chat/chat-defaults.ts";
import type { ChatUIMessage } from "../chat/chat-service.ts";
import type { ChatDto, EnvironmentDto, TaskDto, WikiDto } from "../router.ts";
import { ChatWorkspace } from "./components/chat-workspace.tsx";
import {
  type CommandItem,
  CommandPalette,
} from "./components/command-palette.tsx";
import type { EnvironmentInput } from "./components/environment-dialogs.tsx";
import { PaneResizer } from "./components/pane-resizer.tsx";
import { GeneralSettingsDialog } from "./components/settings-dialog.tsx";
import { Sidebar, type SidebarRequest } from "./components/sidebar.tsx";
import { ArchivedTaskList, TaskList } from "./components/task-list.tsx";
import { TaskOverview } from "./components/task-overview.tsx";
import { Button } from "./components/ui/button.tsx";
import { WikiView } from "./components/wiki-view.tsx";
import {
  ChatDefaultsContext,
  useChatDefaultsState,
} from "./lib/chat-defaults.ts";
import { groupChats, isBlankChat, listedChats } from "./lib/groups.ts";
import {
  newlyAwaiting,
  notifyAwaitingApproval,
  titleFor,
} from "./lib/notify.ts";
import type { ApiClient } from "./lib/orpc.ts";
import {
  ARCHIVED_TASK_LIST_PATH,
  chatIdFromPath,
  isArchivedTaskListPath,
  isTaskListPath,
  pathForChat,
  pathForTask,
  pathForWiki,
  TASK_LIST_PATH,
  taskIdFromPath,
  wikiFromPath,
} from "./lib/route.ts";
import { hasShortcutModifier, USE_COMMAND_SHORTCUT } from "./lib/shortcut.ts";
import {
  SIDE_BY_SIDE_MIN_VIEWPORT,
  useReservedMainWidth,
} from "./lib/side-panel-width.ts";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  loadSidebarWidth,
  saveSidebarWidth,
  sidebarWidthRange,
} from "./lib/sidebar-width.ts";
import { applyTheme, loadTheme, type Theme } from "./lib/theme.ts";
import { useUnreadChats } from "./lib/unread.ts";
import { useWikiPages } from "./lib/use-wiki-pages.ts";

type Status = Awaited<ReturnType<ApiClient["system"]["status"]>>;

/** スレッド一覧の状態（生成中・承認待ち）を拾うための問い合わせ間隔。 */
const LIST_POLL_MS = 2000;

/**
 * Claude Code を使えないときだけ、ヘッダーで知らせる。
 * 使えるときのバージョン・契約プランは「設定 → 一般」に出す（#170）。
 */
const ClaudeStatusBadge = ({ status }: { status: Status | undefined }) => {
  if (status === undefined) {
    return <span className="text-muted-foreground text-xs">接続中…</span>;
  }
  const claude = status.claude;
  switch (claude.state) {
    case "checking":
      return (
        <span className="text-muted-foreground text-xs">
          Claude Code を確認中…
        </span>
      );
    case "ready":
      return null;
    case "not_installed":
    case "error":
      return (
        <span className="text-destructive text-xs" role="alert">
          {claude.message}
        </span>
      );
  }
};

// 改名前（#188）のキーのまま使い、ブラウザに保存した値を引き継ぐ
const SIDEBAR_KEY = "cc-manabu.sidebarOpen";

/** サイドバーを開いているか（ブラウザに覚える。既定は開く）。 */
const loadSidebarOpen = (): boolean => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "0";
  } catch {
    return true;
  }
};

/** ウィンドウの幅。変わったら数え直す。 */
const useViewportWidth = (): number => {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
};

const SIDEBAR_SHORTCUT = USE_COMMAND_SHORTCUT ? "⌘B" : "Ctrl+B";

export const App = ({ api }: { api: ApiClient }) => {
  const [status, setStatus] = useState<Status>();
  const chatDefaults = useChatDefaultsState(api);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** ヘッダーの右側の、開いている画面が操作ボタンを出す場所（#213）。 */
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(
    null,
  );
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  // 左サイドバーの幅（#185）。保存していなければ既定の幅で開き、画面の幅に収めて表示する
  const [savedSidebarWidth, setSavedSidebarWidth] = useState(loadSidebarWidth);
  const viewportWidth = useViewportWidth();
  // 右側のペインを開いている間は、メインと右側のペインの操作に必要な幅を残す（#209）
  const reservedMainWidth = useReservedMainWidth();
  const sidebarReserved =
    viewportWidth >= SIDE_BY_SIDE_MIN_VIEWPORT ? reservedMainWidth : 0;
  const sidebarWidth = clampSidebarWidth(
    savedSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH,
    viewportWidth,
    sidebarReserved,
  );
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "1" : "0");
    } catch {
      // 覚えられなくても開閉はできる
    }
  }, [sidebarOpen]);
  // ⌘B（Ctrl+B）でサイドバーを開閉する
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const hasShortcutModifier = USE_COMMAND_SHORTCUT
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey || event.metaKey;
      if (
        hasShortcutModifier &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "b"
      ) {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);
  // コマンドパレット（#243）。⌘K（Ctrl+K）で開閉する。入力欄にフォーカスがあっても開く
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        hasShortcutModifier(event) &&
        !event.shiftKey &&
        !event.altKey &&
        !event.isComposing &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  /** コマンドパレットからサイドバーに頼む操作（検索欄を開く・タスクを作る）。 */
  const [sidebarRequest, setSidebarRequest] = useState<SidebarRequest>();
  const requestSidebar = (kind: SidebarRequest["kind"]) =>
    setSidebarRequest((prev) => ({ kind, nonce: (prev?.nonce ?? 0) + 1 }));
  /** 開いたらメインの入力欄にフォーカスする会話（コマンドパレットの「新しいスレッド」）。 */
  const [focusComposerOf, setFocusComposerOf] = useState<string>();
  const [chats, setChats] = useState<ChatDto[]>([]);
  const [tasks, setTasks] = useState<TaskDto[]>();
  const [path, setPath] = useState(() => window.location.pathname);
  const selectedId = chatIdFromPath(path);
  const wikiRoute = wikiFromPath(path);
  const wikiState = window.history.state as { returnTo?: string } | null;
  // 回答から Wiki を開いている間も、元のチャットの表示（HEAD を含む）と入力を保つ。
  const chatViewId =
    selectedId ??
    (wikiRoute === undefined
      ? undefined
      : chatIdFromPath(wikiState?.returnTo ?? ""));
  const [current, setCurrent] = useState<{
    chat: ChatDto;
    messages: ChatUIMessage[];
  }>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const next = await api.system.status();
      if (cancelled) return;
      setStatus(next);
      if (next.claude.state === "checking") {
        setTimeout(poll, 1000);
      }
    };
    poll().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api]);

  const previousStatuses = useRef(new Map<string, string>());

  const refreshChats = useCallback(async () => {
    const next = await api.chats.list();
    // 承認待ちになった会話があれば、タブが裏にあるときに通知する
    for (const chat of newlyAwaiting(previousStatuses.current, next)) {
      notifyAwaitingApproval(chat.title);
    }
    previousStatuses.current = new Map(next.map((c) => [c.id, c.status]));
    setChats(next);
  }, [api]);

  useEffect(() => {
    document.title = titleFor(
      chats.filter((chat) => chat.status === "awaiting_approval").length,
    );
  }, [chats]);

  // 一覧は定期的に取り直す（別の会話の生成中・承認待ちを表示するため）
  useEffect(() => {
    void refreshChats();
    const timer = setInterval(() => void refreshChats(), LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshChats]);

  const [wikis, setWikis] = useState<WikiDto[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentDto[]>([]);
  const refreshTasks = useCallback(async () => {
    const [nextTasks, nextWikis, nextEnvironments] = await Promise.all([
      api.tasks.list(),
      api.wikis.list(),
      api.environments.list(),
    ]);
    setTasks(nextTasks);
    setWikis(nextWikis);
    setEnvironments(nextEnvironments);
  }, [api]);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  /**
   * 会話の送信・回答のあと。Claude がツールでタスクの進捗や名前を変えることがあるので（#187）、
   * スレッドと一緒にタスクも取り直す。
   */
  const refreshAfterActivity = useCallback(() => {
    void refreshChats();
    void refreshTasks();
  }, [refreshChats, refreshTasks]);

  /** 検索結果から開いた発言（#115）。開いた会話でその発言へ移動する。 */
  const [focus, setFocus] = useState<{ chatId: string; messageId: string }>();

  // 選んだ会話・タスクを URL に反映し、ブラウザの戻る・進むにも対応する
  const navigate = useCallback(
    (next: string, state?: { returnTo?: string }) => {
      setFocus(undefined);
      if (window.location.pathname !== next) {
        window.history.pushState(state ?? null, "", next);
      }
      setPath(next);
    },
    [],
  );
  const select = useCallback(
    (id: string | undefined) => {
      navigate(pathForChat(id));
      // スレッドを開き直したときにこの会話を表示する（#76）
      if (id !== undefined) {
        void api.chats
          .select({ id })
          .then(() => refreshChats())
          .catch(() => {});
      }
    },
    [navigate, api, refreshChats],
  );

  const searchChats = useCallback(
    (q: string) => api.search.query({ q }),
    [api],
  );
  const openSearchHit = useCallback(
    (chatId: string, messageId?: string) => {
      select(chatId);
      if (messageId !== undefined) setFocus({ chatId, messageId });
    },
    [select],
  );

  useEffect(() => {
    const onPopState = () => {
      setFocus(undefined);
      setPath(window.location.pathname);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    setLoadError(undefined);
    if (chatViewId === undefined) {
      setCurrent(undefined);
      return;
    }
    let cancelled = false;
    api.chats
      .get({ id: chatViewId })
      .then(({ chat, messages }) => {
        if (!cancelled) {
          setCurrent({ chat, messages: messages as ChatUIMessage[] });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrent(undefined);
          setLoadError("会話が見つかりません。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, chatViewId]);

  // 一覧に出すタスク。会話を開いていればその所属先、そうでなければ URL のタスク
  const selectedChat =
    chats.find((chat) => chat.id === selectedId) ??
    (current?.chat.id === selectedId ? current?.chat : undefined);
  const routeTaskId = taskIdFromPath(path) ?? wikiRoute?.taskId;
  const taskId =
    selectedId !== undefined
      ? (selectedChat?.taskId ?? null)
      : routeTaskId !== undefined &&
          (tasks === undefined || tasks.some((task) => task.id === routeTaskId))
        ? routeTaskId
        : null;

  const task = tasks?.find((p) => p.id === taskId);
  // Wiki を使わない環境のタスク（#232）では、Wiki の URL を開いても Wiki を出さない
  const showWiki =
    wikiRoute !== undefined && task !== undefined && task.wikiId !== null;
  const wikiUnavailable =
    wikiRoute !== undefined && task !== undefined && task.wikiId === null;
  /** ヘッダーに出す、いま開いているものの名前。 */
  const headerTitle = isTaskListPath(path)
    ? "タスク一覧"
    : isArchivedTaskListPath(path)
      ? "アーカイブ済みのタスク"
      : showWiki
        ? `Wiki: ${wikis.find((w) => w.id === task.wikiId)?.name ?? task.name}`
        : selectedId !== undefined
          ? selectedChat === undefined
            ? ""
            : selectedChat.title === ""
              ? "新しいスレッド"
              : selectedChat.title
          : (task?.name ?? "");
  // Wiki のページ一覧（サイドバーの一覧とメインのページ表示で共有する）
  const wiki = useWikiPages(api, showWiki ? task.id : undefined);
  const navigateWiki = (pageId: string | undefined) => {
    if (task === undefined) return;
    // 回答から開いたときは、ページを移っても回答に戻れるようにする
    navigate(
      pathForWiki(task.id, pageId),
      wikiState?.returnTo === undefined
        ? undefined
        : { returnTo: wikiState.returnTo },
    );
  };
  const models = status?.claude.state === "ready" ? status.claude.models : [];
  // 右側のペインで開いている会話。メインの会話とともに、新しい回答の印を外す（#234）
  const [sideChatIds, setSideChatIds] = useState<string[]>([]);
  const unreadChatIds = useUnreadChats(chats, [
    showWiki ? undefined : chatViewId,
    ...sideChatIds,
  ]);
  const workspace = chatViewId === undefined ? undefined : current;
  /** 会話が属するタスクの環境（未所属なら undefined）。 */
  const environmentOf = (chat: ChatDto): EnvironmentDto | undefined => {
    const environmentId = tasks?.find(
      (item) => item.id === chat.taskId,
    )?.environmentId;
    return environments.find((environment) => environment.id === environmentId);
  };
  const workspaceGroup =
    chats.find((chat) => chat.id === chatViewId)?.groupId ??
    workspace?.chat.groupId;

  const openTaskListView = (view: "active" | "archived") =>
    navigate(view === "active" ? TASK_LIST_PATH : ARCHIVED_TASK_LIST_PATH);
  /** タスクごとのスレッドの数（アーカイブ済みの一覧に出す）。 */
  const threadCounts = new Map<string, number>();
  for (const group of groupChats(chats)) {
    const owner = group.primary.taskId;
    if (owner !== null)
      threadCounts.set(owner, (threadCounts.get(owner) ?? 0) + 1);
  }

  /**
   * 同じタスクにまだ何も送っていない会話があれば、新しく作らずにそれを開く。
   * 開いた会話の id を返す。
   */
  const newChat = async (owner: string | null): Promise<string> => {
    const blank = chats.find(
      (chat) => chat.taskId === owner && isBlankChat(chat),
    );
    if (blank !== undefined) {
      select(blank.id);
      return blank.id;
    }
    const chat = await api.chats.create({
      taskId: owner,
      ...resolveChatDefaults(chatDefaults.defaults, models),
    });
    await refreshChats();
    select(chat.id);
    return chat.id;
  };

  // コマンドパレットの「新しいスレッド」で開いた会話は、表示できたら入力欄に移る
  const shownChatId =
    current?.chat.id === chatViewId && !showWiki ? chatViewId : undefined;
  useEffect(() => {
    if (focusComposerOf === undefined || shownChatId !== focusComposerOf) {
      return;
    }
    setFocusComposerOf(undefined);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>(
          'section[aria-label="メインのチャット"] textarea[aria-label="メッセージ"]:not([disabled])',
        )
        ?.focus();
    });
  }, [focusComposerOf, shownChatId]);

  /** コマンドパレットの操作（#243）。どれも画面にある同じ操作と同じ処理を使う。 */
  const commands: CommandItem[] = [
    {
      id: "new-thread",
      label: "新しいスレッド",
      keywords: [
        "スレッド",
        "会話",
        "チャット",
        "新規",
        "作成",
        "new",
        "thread",
        "chat",
      ],
      icon: <MessageSquarePlus />,
      run: () => {
        void newChat(taskId).then(setFocusComposerOf);
      },
    },
    {
      id: "search-threads",
      label: "スレッドを検索",
      keywords: ["検索", "探す", "スレッド", "会話", "search", "find"],
      icon: <Search />,
      run: () => {
        setSidebarOpen(true);
        requestSidebar("search");
      },
    },
    {
      id: "task-list",
      label: "タスク一覧",
      keywords: ["タスク", "一覧", "カンバン", "進捗", "tasks", "kanban"],
      icon: <LayoutList />,
      run: () => navigate(TASK_LIST_PATH),
    },
    {
      id: "new-task",
      label: "新しいタスク",
      keywords: ["タスク", "新規", "作成", "new", "task"],
      icon: <FolderPlus />,
      run: () => requestSidebar("createTask"),
    },
  ];

  /** environmentId を渡すとその環境に、無ければ同じ名前の環境を新しく作って入れる。 */
  const createTask = async (name: string, environmentId?: string) => {
    const task = await api.tasks.create({
      name,
      ...(environmentId === undefined ? {} : { environmentId }),
    });
    await refreshTasks();
    navigate(pathForTask(task.id));
  };

  const createEnvironment = async (input: EnvironmentInput) => {
    await api.environments.create(input);
    await refreshTasks();
  };

  const updateEnvironment = async (id: string, input: EnvironmentInput) => {
    await api.environments.update({ id, ...input });
    await refreshTasks();
  };

  const deleteEnvironment = async (id: string) => {
    await api.environments.delete({ id });
    await refreshTasks();
  };

  const setTaskEnvironment = async (id: string, environmentId: string) => {
    await api.tasks.setEnvironment({ id, environmentId });
    await refreshTasks();
  };

  const pickDirectory = async () => (await api.system.pickDirectory()).path;

  const renameTask = async (id: string, name: string) => {
    await api.tasks.rename({ id, name });
    await refreshTasks();
  };

  const deleteTask = async (id: string) => {
    await api.tasks.delete({ id });
    await Promise.all([refreshTasks(), refreshChats()]);
    // 開いているタスク（またはその会話）を消したときだけ移動する
    if (id === taskId) navigate(pathForTask(null));
  };

  /** タスクをアーカイブする・復元する（#241）。開いている画面はそのまま。 */
  const setTaskArchived = async (id: string, archived: boolean) => {
    await api.tasks.setArchived({ id, archived });
    await refreshTasks();
  };

  const renameWiki = async (id: string, name: string) => {
    await api.wikis.rename({ id, name });
    await refreshTasks();
  };

  const setAutoTerms = async (id: string, enabled: boolean) => {
    await api.tasks.setAutoTerms({ id, enabled });
    await refreshTasks();
  };

  const setTask = async (chatId: string, next: string | null) => {
    await api.chats.setTask({ id: chatId, taskId: next });
    // 開いている会話を今の一覧から外したら、一覧ごと移動せずにこのタスクに留まる
    if (chatId === selectedId && next !== taskId) {
      navigate(pathForTask(taskId));
    }
    await refreshChats();
  };

  const rename = async (id: string, title: string) => {
    await api.chats.rename({ id, title });
    await refreshChats();
  };

  const remove = async (id: string) => {
    await api.chats.delete({ id });
    if (id === selectedId) {
      select(undefined);
    }
    await refreshChats();
  };

  return (
    <ChatDefaultsContext.Provider value={chatDefaults}>
      <div className="flex h-full">
        <Sidebar
          id="sidebar"
          hidden={!sidebarOpen}
          width={sidebarWidth}
          chats={listedChats(chats, selectedId)}
          tasks={tasks ?? []}
          environments={environments}
          wikis={wikis}
          defaultDirectory={status?.cwd}
          taskId={taskId}
          selectedId={selectedId}
          openTaskId={
            selectedId === undefined && wikiRoute === undefined
              ? task?.id
              : undefined
          }
          openWikiTaskId={showWiki ? task.id : undefined}
          onNewInTask={(id) => void newChat(id)}
          onSelect={select}
          onRename={rename}
          onDelete={remove}
          onOpenTask={(id) => navigate(pathForTask(id))}
          onOpenWiki={(id) => navigate(pathForWiki(id))}
          onCreateTask={createTask}
          onCreateEnvironment={createEnvironment}
          onUpdateEnvironment={updateEnvironment}
          onDeleteEnvironment={deleteEnvironment}
          onPickDirectory={pickDirectory}
          onSetTaskEnvironment={setTaskEnvironment}
          onRenameWiki={renameWiki}
          onRenameTask={renameTask}
          onDeleteTask={deleteTask}
          onArchiveTask={(id) => setTaskArchived(id, true)}
          onArchiveThread={async (id, archived) => {
            await api.chats.setArchived({ id, archived });
            await refreshChats();
          }}
          unreadChatIds={unreadChatIds}
          onSetTask={setTask}
          onSetAutoTerms={setAutoTerms}
          onOpenTaskList={() => navigate(TASK_LIST_PATH)}
          onOpenGeneralSettings={() => setSettingsOpen(true)}
          onSearch={searchChats}
          onOpenSearchHit={openSearchHit}
          request={sidebarRequest}
        />
        {sidebarOpen && (
          <PaneResizer
            side="left"
            label="サイドバーの幅"
            title="ドラッグしてサイドバーの幅を変える（←→ キーでも変えられます）"
            controls="sidebar"
            width={sidebarWidth}
            {...sidebarWidthRange(viewportWidth, sidebarReserved)}
            onResize={setSavedSidebarWidth}
            onCommit={saveSidebarWidth}
          />
        )}
        <main
          className="flex min-w-0 flex-1 flex-col"
          data-claude-state={status?.claude.state ?? "connecting"}
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label={
                sidebarOpen ? "サイドバーを閉じる" : "サイドバーを開く"
              }
              title={`${sidebarOpen ? "サイドバーを閉じる" : "サイドバーを開く"}（${SIDEBAR_SHORTCUT}）`}
              aria-expanded={sidebarOpen}
              aria-controls="sidebar"
              onClick={toggleSidebar}
            >
              {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
            <span className="min-w-0 flex-1 truncate font-medium text-sm">
              {headerTitle}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              {/* 開いている画面の操作（Wiki の概要と操作ボタンなど。#213） */}
              <div
                ref={setHeaderActions}
                className="flex items-center gap-1 empty:hidden"
              />
              <ClaudeStatusBadge status={status} />
            </div>
          </header>
          {workspace !== undefined && (
            <div className={showWiki ? "hidden" : "flex min-h-0 flex-1"}>
              <ChatWorkspace
                key={workspaceGroup || workspace.chat.id}
                api={api}
                chat={workspace.chat}
                initialMessages={workspace.messages}
                loading={workspace.chat.id !== chatViewId}
                models={models}
                cwd={workspace.chat.cwd}
                environment={environmentOf(workspace.chat)}
                onActivity={refreshAfterActivity}
                branches={chats.filter(
                  (chat) => chat.groupId === workspace.chat.groupId,
                )}
                onSelectBranch={select}
                onOpenChat={select}
                // Wiki を使わない環境のタスクでは、回答からノートを作れない（#232）
                {...(tasks?.find((item) => item.id === workspace.chat.taskId)
                  ?.wikiId === null
                  ? {}
                  : { onWikiPageCreated: () => void wiki.refresh() })}
                {...(focus?.chatId === workspace.chat.id
                  ? { focusMessage: focus }
                  : {})}
                onOpenWikiPage={(taskId, pageId) =>
                  navigate(pathForWiki(taskId, pageId), { returnTo: path })
                }
                headerSlot={showWiki ? null : headerActions}
                task={tasks?.find((item) => item.id === workspace.chat.taskId)}
                onOpenTask={(id) => navigate(pathForTask(id))}
                unreadChatIds={unreadChatIds}
                onSideChatsChange={setSideChatIds}
              />
            </div>
          )}
          {isTaskListPath(path) ? (
            <TaskList
              tasks={tasks ?? []}
              onOpen={(id) => navigate(pathForTask(id))}
              onMove={async (id, status) => {
                await api.tasks.updateProgress({ id, status });
                await refreshTasks();
              }}
              onOpenView={openTaskListView}
            />
          ) : isArchivedTaskListPath(path) ? (
            <ArchivedTaskList
              tasks={tasks ?? []}
              environments={environments}
              threadCounts={threadCounts}
              onOpen={(id) => navigate(pathForTask(id))}
              onRestore={(id) => setTaskArchived(id, false)}
              onOpenView={openTaskListView}
            />
          ) : showWiki ? (
            <WikiView
              key={task.id}
              api={api}
              pages={wiki.pages}
              loadError={wiki.loadError}
              refresh={wiki.refresh}
              taskId={task.id}
              taskName={task.name}
              wikiName={wikis.find((wiki) => wiki.id === task.wikiId)?.name}
              referencingTasks={(tasks ?? [])
                .filter((p) => p.wikiId === task.wikiId)
                .map((p) => ({ id: p.id, name: p.name }))}
              autoTerms={task.autoTerms}
              headerActions={headerActions}
              onOpenTask={(id) => navigate(pathForTask(id))}
              pageId={wikiRoute.pageId}
              models={models}
              hasPageChat={chats.some(
                (chat) =>
                  chat.taskId === task.id &&
                  chat.parentId === null &&
                  chat.wikiPageId === wikiRoute.pageId,
              )}
              onChatActivity={refreshAfterActivity}
              onOpenChat={select}
              returnTo={wikiState?.returnTo}
              onReturn={(to) => navigate(to)}
              onNavigate={navigateWiki}
              onOpenAnswer={openSearchHit}
            />
          ) : workspace !== undefined ? null : selectedId === undefined &&
            wikiRoute === undefined &&
            task !== undefined ? (
            <TaskOverview
              key={task.id}
              api={api}
              task={task}
              threads={groupChats(listedChats(chats, selectedId))
                .filter((group) => group.primary.taskId === task.id)
                .map((group) => group.primary)}
              onOpenChat={select}
              onOpenWiki={() => navigate(pathForWiki(task.id))}
              onNewChat={() => void newChat(task.id)}
              onChanged={refreshTasks}
              onRestore={() => setTaskArchived(task.id, false)}
            />
          ) : (
            <section className="flex flex-1 items-center justify-center text-muted-foreground">
              {loadError ??
                (wikiUnavailable
                  ? "このタスクの環境は Wiki を使っていません。"
                  : selectedId === undefined
                    ? "スレッドを選ぶか、新しいスレッドを始めてください。"
                    : "読み込み中…")}
            </section>
          )}
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={commands}
      />
      <GeneralSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        claude={status?.claude}
        theme={theme}
        onThemeChange={setTheme}
      />
    </ChatDefaultsContext.Provider>
  );
};
