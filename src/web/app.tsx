import { Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatUIMessage } from "../chat/chat-service.ts";
import type { ChatDto, ProjectDto, WikiDto } from "../router.ts";
import { ChatView } from "./components/chat-view.tsx";
import { ProjectList } from "./components/project-list.tsx";
import { ProjectOverview } from "./components/project-overview.tsx";
import { RateLimitBadge } from "./components/rate-limit-badge.tsx";
import { Sidebar } from "./components/sidebar.tsx";
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
  isProjectListPath,
  PROJECT_LIST_PATH,
  pathForChat,
  pathForProject,
  pathForWiki,
  projectIdFromPath,
  wikiFromPath,
} from "./lib/route.ts";
import { applyTheme, loadTheme, type Theme } from "./lib/theme.ts";

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
        <span className="text-muted-foreground text-xs">
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

export const App = ({ api }: { api: ApiClient }) => {
  const [status, setStatus] = useState<Status>();
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [chats, setChats] = useState<ChatDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>();
  const [path, setPath] = useState(() => window.location.pathname);
  const selectedId = chatIdFromPath(path);
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
  const refreshProjects = useCallback(async () => {
    const [nextProjects, nextWikis] = await Promise.all([
      api.projects.list(),
      api.wikis.list(),
    ]);
    setProjects(nextProjects);
    setWikis(nextWikis);
  }, [api]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  // 選んだ会話・プロジェクトを URL に反映し、ブラウザの戻る・進むにも対応する
  const navigate = useCallback(
    (next: string, state?: { returnTo?: string; draft?: PageDraft }) => {
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

  /** 検索結果から開いた発言（#115）。開いた会話でその発言へ移動する。 */
  const [focus, setFocus] = useState<{ chatId: string; messageId: string }>();
  const searchChats = useCallback(
    (q: string) => api.search.query({ q }),
    [api],
  );
  const openSearchHit = useCallback(
    (chatId: string, messageId?: string) => {
      setFocus(messageId === undefined ? undefined : { chatId, messageId });
      select(chatId);
    },
    [select],
  );

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    setLoadError(undefined);
    if (selectedId === undefined) {
      setCurrent(undefined);
      return;
    }
    let cancelled = false;
    api.chats
      .get({ id: selectedId })
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
  }, [api, selectedId]);

  // 一覧に出すプロジェクト。会話を開いていればその所属先、そうでなければ URL のプロジェクト
  const selectedChat =
    chats.find((chat) => chat.id === selectedId) ??
    (current?.chat.id === selectedId ? current?.chat : undefined);
  const wikiRoute = wikiFromPath(path);
  const routeProjectId = projectIdFromPath(path) ?? wikiRoute?.projectId;
  const projectId =
    selectedId !== undefined
      ? (selectedChat?.projectId ?? null)
      : routeProjectId !== undefined &&
          (projects === undefined ||
            projects.some((project) => project.id === routeProjectId))
        ? routeProjectId
        : null;

  const project = projects?.find((p) => p.id === projectId);
  const showWiki = wikiRoute !== undefined && project !== undefined;
  const wikiState = window.history.state as {
    returnTo?: string;
    draft?: PageDraft;
  } | null;

  const newChat = async () => {
    const chat = await api.chats.create({ projectId });
    await refreshChats();
    select(chat.id);
  };

  /** wikiId を渡すとその Wiki を共有し、無ければ新しい Wiki を作る。 */
  const createProject = async (name: string, wikiId?: string) => {
    const project = await api.projects.create({
      name,
      ...(wikiId === undefined ? {} : { wikiId }),
    });
    await refreshProjects();
    navigate(pathForProject(project.id));
  };

  const renameProject = async (id: string, name: string) => {
    await api.projects.rename({ id, name });
    await refreshProjects();
  };

  const deleteProject = async (id: string) => {
    await api.projects.delete({ id });
    await Promise.all([refreshProjects(), refreshChats()]);
    navigate(pathForProject(null));
  };

  const renameWiki = async (id: string, name: string) => {
    await api.wikis.rename({ id, name });
    await refreshProjects();
  };

  const setAutoTerms = async (id: string, enabled: boolean) => {
    await api.projects.setAutoTerms({ id, enabled });
    await refreshProjects();
  };

  const setProject = async (chatId: string, next: string | null) => {
    await api.chats.setProject({ id: chatId, projectId: next });
    // 開いている会話を今の一覧から外したら、一覧ごと移動せずにこのプロジェクトに留まる
    if (chatId === selectedId && next !== projectId) {
      navigate(pathForProject(projectId));
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
        chats={chats}
        projects={projects ?? []}
        projectId={projectId}
        selectedId={selectedId}
        onNew={() => void newChat()}
        onSelect={(id) => {
          setFocus(undefined);
          select(id);
        }}
        onRename={rename}
        onDelete={remove}
        onSelectProject={(id) => navigate(pathForProject(id))}
        onCreateProject={createProject}
        wikis={wikis}
        onRenameWiki={renameWiki}
        onRenameProject={renameProject}
        onDeleteProject={deleteProject}
        onSetProject={setProject}
        view={showWiki ? "wiki" : "threads"}
        onOpenWiki={() => {
          if (projectId !== null) navigate(pathForWiki(projectId));
        }}
        onSetAutoTerms={setAutoTerms}
        onOpenProjectList={() => navigate(PROJECT_LIST_PATH)}
        onSearch={searchChats}
        onOpenSearchHit={openSearchHit}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4">
          <span className="truncate text-muted-foreground text-sm">
            {status?.cwd ?? ""}
          </span>
          <div className="flex shrink-0 items-center gap-3">
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
        {isProjectListPath(path) ? (
          <ProjectList
            projects={projects ?? []}
            onOpen={(id) => navigate(pathForProject(id))}
          />
        ) : showWiki ? (
          <WikiView
            key={project.id}
            api={api}
            projectId={project.id}
            projectName={project.name}
            wikiName={wikis.find((wiki) => wiki.id === project.wikiId)?.name}
            sharedWith={(projects ?? [])
              .filter((p) => p.wikiId === project.wikiId && p.id !== project.id)
              .map((p) => p.name)}
            autoTerms={project.autoTerms}
            pageId={wikiRoute.pageId}
            onOpenChat={select}
            returnTo={wikiState?.returnTo}
            initialDraft={wikiState?.draft}
            onReturn={(to) => navigate(to)}
            onNavigate={(pageId) =>
              // 回答から開いたときは、ページを移っても回答に戻れるようにする
              navigate(
                pathForWiki(project.id, pageId),
                wikiState?.returnTo === undefined
                  ? undefined
                  : { returnTo: wikiState.returnTo },
              )
            }
          />
        ) : current !== undefined && current.chat.id === selectedId ? (
          <ChatView
            key={current.chat.id}
            api={api}
            chat={current.chat}
            initialMessages={current.messages}
            models={
              status?.claude.state === "ready" ? status.claude.models : []
            }
            onActivity={() => void refreshChats()}
            branches={chats.filter(
              (chat) => chat.groupId === current.chat.groupId,
            )}
            onSelectBranch={select}
            onCreateWikiPage={(projectId, draft) =>
              navigate(pathForWiki(projectId), { returnTo: path, draft })
            }
            {...(focus?.chatId === current.chat.id
              ? { focusMessageId: focus.messageId }
              : {})}
            onOpenWikiPage={(projectId, pageId) =>
              // Wiki から元の回答に戻れるようにする
              navigate(pathForWiki(projectId, pageId), { returnTo: path })
            }
          />
        ) : selectedId === undefined &&
          wikiRoute === undefined &&
          project !== undefined ? (
          <ProjectOverview
            key={project.id}
            api={api}
            project={project}
            threads={groupChats(chats)
              .filter((group) => group.primary.projectId === project.id)
              .map((group) => group.primary)}
            onOpenChat={select}
            onOpenWiki={() => navigate(pathForWiki(project.id))}
            onNewChat={() => void newChat()}
            onChanged={refreshProjects}
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
