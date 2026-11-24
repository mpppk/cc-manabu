import { Moon, PanelLeftClose, PanelLeftOpen, Sun } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatUIMessage } from "../chat/chat-service.ts";
import type { ChatDto, TaskDto, WikiDto } from "../router.ts";
import { ChatWorkspace } from "./components/chat-workspace.tsx";
import { RateLimitBadge } from "./components/rate-limit-badge.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import { TaskList } from "./components/task-list.tsx";
import { TaskOverview } from "./components/task-overview.tsx";
import { Button } from "./components/ui/button.tsx";
import { WikiView } from "./components/wiki-view.tsx";
import { groupChats } from "./lib/groups.ts";
import {
  newlyAwaiting,
  notifyAwaitingApproval,
  titleFor,
} from "./lib/notify.ts";
import type { ApiClient } from "./lib/orpc.ts";
import type { PageDraft } from "./lib/page-draft.ts";
import {
  chatIdFromPath,
  isTaskListPath,
  pathForChat,
  pathForTask,
  pathForWiki,
  TASK_LIST_PATH,
  taskIdFromPath,
  wikiFromPath,
} from "./lib/route.ts";
import { applyTheme, loadTheme, type Theme } from "./lib/theme.ts";
import { useWikiPages } from "./lib/use-wiki-pages.ts";

type Status = Awaited<ReturnType<ApiClient["system"]["status"]>>;

/** 会話一覧の状態（生成中・承認待ち）を拾うための問い合わせ間隔。 */
const LIST_POLL_MS = 2000;

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
      return (
        <span
          className="hidden text-muted-foreground text-xs lg:inline"
          title={`Claude Code ${claude.version ?? ""}${claude.account.subscriptionType ? `・${claude.account.subscriptionType}` : ""}`}
        >
          Claude Code {claude.version ?? ""}
          {claude.account.subscriptionType
            ? `・${claude.account.subscriptionType}`
            : ""}
        </span>
      );
    case "not_installed":
    case "error":
      return (
        <span className="text-destructive text-xs" role="alert">
          {claude.message}
        </span>
      );
  }
};

const SIDEBAR_KEY = "cc-manabu.sidebarOpen";

/** サイドバーを開いているか（ブラウザに覚える。既定は開く）。 */
const loadSidebarOpen = (): boolean => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "0";
  } catch {
    return true;
  }
};

/** サイドバーの開閉のショートカットの表記（Mac は ⌘B、それ以外は Ctrl+B）。 */
const SIDEBAR_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform)
  ? "⌘B"
  : "Ctrl+B";

export const App = ({ api }: { api: ApiClient }) => {
  const [status, setStatus] = useState<Status>();
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
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
      if (
        (event.metaKey || event.ctrlKey) &&
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
  const [chats, setChats] = useState<ChatDto[]>([]);
  const [tasks, setTasks] = useState<TaskDto[]>();
  const [path, setPath] = useState(() => window.location.pathname);
  const selectedId = chatIdFromPath(path);
  const wikiRoute = wikiFromPath(path);
  const wikiState = window.history.state as {
    returnTo?: string;
    draft?: PageDraft;
  } | null;
  // 回答から Wiki を開いている間も、元のチャットの現在地と入力を保つ。
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
  const refreshTasks = useCallback(async () => {
    const [nextTasks, nextWikis] = await Promise.all([
      api.tasks.list(),
      api.wikis.list(),
    ]);
    setTasks(nextTasks);
    setWikis(nextWikis);
  }, [api]);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  /** 検索結果から開いた発言（#115）。開いた会話でその発言へ移動する。 */
  const [focus, setFocus] = useState<{ chatId: string; messageId: string }>();

  // 選んだ会話・タスクを URL に反映し、ブラウザの戻る・進むにも対応する
  const navigate = useCallback(
    (next: string, state?: { returnTo?: string; draft?: PageDraft }) => {
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
      // 会話を開き直したときにこの分岐を表示する（#76）
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
  const showWiki = wikiRoute !== undefined && task !== undefined;
  /** ヘッダーに出す、いま開いているものの名前。 */
  const headerTitle = isTaskListPath(path)
    ? "タスク一覧"
    : showWiki
      ? `Wiki: ${wikis.find((w) => w.id === task.wikiId)?.name ?? task.name}`
      : selectedId !== undefined
        ? selectedChat === undefined
          ? ""
          : selectedChat.title === ""
            ? "新しい会話"
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
  const workspace = chatViewId === undefined ? undefined : current;
  const workspaceGroup =
    chats.find((chat) => chat.id === chatViewId)?.groupId ??
    workspace?.chat.groupId;

  const newChat = async (owner: string | null) => {
    const chat = await api.chats.create({ taskId: owner });
    await refreshChats();
    select(chat.id);
  };

  /** wikiId を渡すとその Wiki を共有し、無ければ新しい Wiki を作る。 */
  const createTask = async (name: string, wikiId?: string) => {
    const task = await api.tasks.create({
      name,
      ...(wikiId === undefined ? {} : { wikiId }),
    });
    await refreshTasks();
    navigate(pathForTask(task.id));
  };

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
    <div className="flex h-full">
      <Sidebar
        id="sidebar"
        hidden={!sidebarOpen}
        chats={chats}
        tasks={tasks ?? []}
        wikis={wikis}
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
        onRenameWiki={renameWiki}
        onRenameTask={renameTask}
        onDeleteTask={deleteTask}
        onSetTask={setTask}
        onSetAutoTerms={setAutoTerms}
        onOpenTaskList={() => navigate(TASK_LIST_PATH)}
        onSearch={searchChats}
        onOpenSearchHit={openSearchHit}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label={sidebarOpen ? "サイドバーを閉じる" : "サイドバーを開く"}
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
            <RateLimitBadge
              api={api}
              activity={chats
                .map(
                  (chat) =>
                    `${chat.id}:${chat.status}:${String(chat.updatedAt)}`,
                )
                .join(",")}
            />
            <ClaudeStatusBadge status={status} />
            <Button
              variant="ghost"
              size="icon"
              aria-label="テーマを切り替える"
              onClick={() =>
                setTheme(
                  document.documentElement.classList.contains("dark")
                    ? "light"
                    : "dark",
                )
              }
            >
              <Sun className="dark:hidden" />
              <Moon className="hidden dark:block" />
            </Button>
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
              {...(status?.cwd === undefined ? {} : { cwd: status.cwd })}
              onActivity={() => void refreshChats()}
              branches={chats.filter(
                (chat) => chat.groupId === workspace.chat.groupId,
              )}
              onSelectBranch={select}
              onCreateWikiPage={(taskId, draft) =>
                navigate(pathForWiki(taskId), { returnTo: path, draft })
              }
              {...(focus?.chatId === workspace.chat.id
                ? { focusMessage: focus }
                : {})}
              onOpenWikiPage={(taskId, pageId) =>
                navigate(pathForWiki(taskId, pageId), { returnTo: path })
              }
            />
          </div>
        )}
        {isTaskListPath(path) ? (
          <TaskList
            tasks={tasks ?? []}
            onOpen={(id) => navigate(pathForTask(id))}
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
            sharedWith={(tasks ?? [])
              .filter((p) => p.wikiId === task.wikiId && p.id !== task.id)
              .map((p) => p.name)}
            autoTerms={task.autoTerms}
            pageId={wikiRoute.pageId}
            models={models}
            hasPageChat={chats.some(
              (chat) =>
                chat.taskId === task.id &&
                chat.parentId === null &&
                chat.wikiPageId === wikiRoute.pageId,
            )}
            onChatActivity={() => void refreshChats()}
            onOpenChat={select}
            returnTo={wikiState?.returnTo}
            initialDraft={wikiState?.draft}
            onReturn={(to) => navigate(to)}
            onNavigate={navigateWiki}
          />
        ) : workspace !== undefined ? null : selectedId === undefined &&
          wikiRoute === undefined &&
          task !== undefined ? (
          <TaskOverview
            key={task.id}
            api={api}
            task={task}
            threads={groupChats(chats)
              .filter((group) => group.primary.taskId === task.id)
              .map((group) => group.primary)}
            onOpenChat={select}
            onOpenWiki={() => navigate(pathForWiki(task.id))}
            onNewChat={() => void newChat(task.id)}
            onChanged={refreshTasks}
          />
        ) : (
          <section className="flex flex-1 items-center justify-center text-muted-foreground">
            {loadError ??
              (selectedId === undefined
                ? "会話を選ぶか、新しい会話を始めてください。"
                : "読み込み中…")}
          </section>
        )}
      </main>
    </div>
  );
};
