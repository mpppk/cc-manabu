import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  ArrowLeft,
  FilePlus,
  History,
  MessageCircle,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { WikiPageQuote } from "../../chat/quote.ts";
import type { WikiPageDto, WikiVersionDto } from "../../router.ts";
import { searchPages } from "../../wiki/match.ts";
import type { ApiClient } from "../lib/orpc.ts";
import {
  MIN_SIDE_PANEL_WIDTH,
  useElementWidth,
  useReserveMainWidth,
  useSidePanelWidth,
} from "../lib/side-panel-width.ts";
import { cn } from "../lib/utils.ts";
import { SideChat, SidePanelResizer } from "./chat-workspace.tsx";
import { PageQaList } from "./page-qa-list.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogFooter } from "./ui/dialog.tsx";
import { WikiHistoryPanel, WikiHistoryToolbar } from "./wiki-history.tsx";
import { type WikiNoteTerms, WikiPageContent, WikiPane } from "./wiki-pane.tsx";

type Draft = { title: string; aliases: string; body: string };

const toDraft = (page?: WikiPageDto): Draft => ({
  title: page?.title ?? "",
  aliases: page?.aliases.join(", ") ?? "",
  body: page?.body ?? "",
});

const parseAliases = (value: string): string[] =>
  value
    .split(/[,、]/)
    .map((alias) => alias.trim())
    .filter((alias) => alias !== "");

/** ページの作成・編集フォーム。 */
const PageEditor = ({
  initial,
  onSave,
  onCancel,
}: {
  initial: Draft;
  onSave: (draft: Draft) => Promise<void>;
  onCancel: () => void;
}) => {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (draft.title.trim() === "") return;
    setError(undefined);
    await onSave(draft).catch(() => setError("保存できませんでした。"));
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <input
        className="rounded-md border bg-background px-3 py-2 font-semibold text-lg"
        aria-label="ノートのタイトル"
        placeholder="タイトル（例: 関係タプル）"
        maxLength={200}
        value={draft.title}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
      />
      <input
        className="rounded-md border bg-background px-3 py-2 text-sm"
        aria-label="別名（カンマ区切り）"
        placeholder="別名（カンマ区切り。例: relation tuple, タプル）"
        value={draft.aliases}
        onChange={(event) =>
          setDraft({ ...draft, aliases: event.target.value })
        }
      />
      <textarea
        className="min-h-80 resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm"
        aria-label="本文（Markdown）"
        placeholder="本文（Markdown）"
        value={draft.body}
        onChange={(event) => setDraft({ ...draft, body: event.target.value })}
      />
      {error !== undefined && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          キャンセル
        </Button>
        <Button type="submit" disabled={draft.title.trim() === ""}>
          保存
        </Button>
      </div>
    </form>
  );
};

/** Wiki のページ一覧（検索つき）。Wiki 画面の左に出す。 */
const WikiPageList = ({
  pages,
  loadError,
  pageId,
  onNavigate,
}: {
  /** undefined は読み込み中。 */
  pages: WikiPageDto[] | undefined;
  loadError: string | undefined;
  /** 開いているページ。 */
  pageId: string | undefined;
  onNavigate: (pageId: string) => void;
}) => {
  const [query, setQuery] = useState("");
  const found = pages === undefined ? [] : searchPages(pages, query);
  const message =
    loadError ??
    (pages === undefined
      ? "読み込み中…"
      : pages.length === 0
        ? "まだノートがありません。「新しいノート」から作れます。"
        : found.length === 0
          ? "一致するノートはありません。"
          : undefined);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-md border bg-background px-2 py-1">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            aria-label="Wiki を検索"
            placeholder="タイトル・別名・本文で絞り込む"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2" aria-label="ノート一覧">
        {message !== undefined ? (
          <p
            className={cn(
              "px-2 py-4 text-sm",
              loadError === undefined
                ? "text-muted-foreground"
                : "text-destructive",
            )}
            role={loadError === undefined ? undefined : "alert"}
          >
            {message}
          </p>
        ) : (
          <ul aria-label="ノート" className="flex flex-col gap-0.5">
            {found.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                    p.id === pageId && "bg-accent font-medium",
                  )}
                  aria-current={p.id === pageId ? "page" : undefined}
                  onClick={() => onNavigate(p.id)}
                >
                  <span className="w-full truncate">{p.title}</span>
                  {p.aliases.length > 0 && (
                    <span className="w-full truncate font-normal text-muted-foreground text-xs">
                      別名: {p.aliases.join("、")}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </div>
  );
};

/** タスクの Wiki（ページの一覧・検索・閲覧・作成・編集・削除）。 */
/** ノートの一覧の幅（w-60）。 */
const WIKI_PAGE_LIST_WIDTH = 240;

export const WikiView = ({
  api,
  pages,
  loadError,
  refresh,
  taskId,
  taskName,
  wikiName,
  sharedWith = [],
  autoTerms,
  pageId,
  models,
  hasPageChat,
  onChatActivity,
  onNavigate,
  onOpenChat,
  returnTo,
  onReturn,
  onOpenAnswer,
}: {
  /** ページの一覧（サイドバーと共有する）。undefined は読み込み中。 */
  pages: WikiPageDto[] | undefined;
  loadError: string | undefined;
  /** ページを変えたあとに一覧を読み直す。 */
  refresh: () => Promise<void>;
  api: ApiClient;
  taskId: string;
  taskName: string;
  /** Wiki の名前（無ければタスク名を使う）。 */
  wikiName?: string | undefined;
  /** 同じ Wiki を使っている、ほかのタスクの名前。 */
  sharedWith?: string[];
  /** 回答からの用語ページの自動作成が有効か。 */
  autoTerms: boolean;
  /** 自動作成の元になった会話を開く。 */
  onOpenChat: (chatId: string) => void;
  /** 回答から開いたときの戻り先（回答のある会話のパス）。 */
  returnTo?: string | undefined;
  onReturn: (path: string) => void;
  /** 開いているページ。undefined なら一覧。 */
  pageId: string | undefined;
  models: ModelInfo[];
  hasPageChat: boolean;
  onChatActivity: () => void;
  onNavigate: (pageId: string | undefined) => void;
  /** 変更履歴の Claude の版から、元の会話・回答を開く（#166）。 */
  onOpenAnswer?: (chatId: string, messageId?: string) => void;
}) => {
  const [mode, setMode] = useState<"view" | "new" | "edit">("view");
  const [deleting, setDeleting] = useState(false);
  const [askingPageId, setAskingPageId] = useState<string>();
  /** 本文から選んで、次の質問に添える引用。 */
  const [quote, setQuote] = useState<WikiPageQuote>();
  const askButton = useRef<HTMLButtonElement>(null);
  /**
   * サイドチャットの回答中の用語から、サイドチャットの上に重ねて開いた Wiki ページ（#168）。
   * 閉じると、隠していたサイドチャットに入力途中のまま戻る。
   */
  const [termPane, setTermPane] = useState<{
    id: string;
    pageId: string;
    returnFocus: HTMLElement | null;
  }>();
  const openTermPane = (termPageId: string) => {
    const active = document.activeElement;
    setTermPane({
      id: crypto.randomUUID(),
      pageId: termPageId,
      returnFocus:
        active instanceof HTMLElement && active !== document.body
          ? active
          : null,
    });
  };
  const closeTermPane = () => {
    const returnFocus = termPane?.returnFocus;
    setTermPane(undefined);
    requestAnimationFrame(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
    });
  };
  /** 変更履歴を開いているか（#166）。 */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Wiki が変わるたびに増やす（元に戻せる変更・履歴・削除したノートを読み直す）。 */
  const [historyRevision, setHistoryRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: ノートの一覧が変わったら読み直す
  useEffect(() => setHistoryRevision((revision) => revision + 1), [pages]);
  /** 削除したノート（版から復元できる）。 */
  const [deletedPages, setDeletedPages] = useState<WikiVersionDto[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Wiki が変わったら読み直す
  useEffect(() => {
    let active = true;
    api.wiki.deletedPages({ taskId }).then(
      (loaded) => active && setDeletedPages(loaded),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [api, taskId, historyRevision]);
  /** サイドチャットで質問・回答があるたびに増やす（Q&A を読み直す。#159）。 */
  const [qaRevision, setQaRevision] = useState(0);
  const closeChat = () => {
    setAskingPageId(undefined);
    setQuote(undefined);
    setTermPane(undefined);
    requestAnimationFrame(() => askButton.current?.focus());
  };

  // ページを移ったら閲覧に戻す（開いたときは下書きの作成画面のまま）
  const openedPageId = useRef(pageId);
  useEffect(() => {
    if (openedPageId.current === pageId) return;
    openedPageId.current = pageId;
    setMode("view");
    setAskingPageId(undefined);
    setQuote(undefined);
    setTermPane(undefined);
    setHistoryOpen(false);
  }, [pageId]);

  const page = pages?.find((p) => p.id === pageId);
  // 本文の用語から、同じ Wiki の別のノートの説明を出し、この画面で開く（#210）
  const noteTerms = useMemo<WikiNoteTerms>(
    () => ({
      pages,
      load: (id) => api.wiki.get({ id }).catch(() => undefined),
      open: onNavigate,
      openLabel: "ノートを開く",
    }),
    [api, pages, onNavigate],
  );
  const asking = pageId !== undefined && askingPageId === pageId;
  // 右側のペインの幅（#209）。ノート本文と並べる領域の幅に収める
  const row = useRef<HTMLDivElement>(null);
  const sidePanel = useSidePanelWidth(useElementWidth(row));
  // 左サイドバーを広げても、ノートの一覧・本文・右側のペインが並ぶ幅を残す
  useReserveMainWidth(asking ? WIKI_PAGE_LIST_WIDTH + MIN_SIDE_PANEL_WIDTH : 0);
  const openChatButton = (label: string) => (
    <Button
      ref={askButton}
      variant="outline"
      size="sm"
      aria-expanded={asking}
      onClick={() => setAskingPageId(pageId)}
    >
      <MessageCircle className="size-3.5" />
      {label}
    </Button>
  );

  const header = (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate font-semibold text-lg">
          {wikiName === undefined || wikiName === taskName
            ? `${taskName} の Wiki`
            : `Wiki: ${wikiName}`}
        </h1>
        {sharedWith.length > 0 && (
          <span className="text-muted-foreground text-xs">
            {sharedWith.map((name) => `「${name}」`).join("")}
            と共有している Wiki
            です。ノートの変更はすべてのタスクに反映されます。
          </span>
        )}
        <span className="text-muted-foreground text-xs">
          回答からの用語ノートの自動作成: {autoTerms ? "オン" : "オフ"}
          （タスクの設定で変更できます）
        </span>
      </div>
      {mode === "view" && (
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button size="sm" onClick={() => setMode("new")}>
            <FilePlus className="size-4" />
            新しいノート
          </Button>
          <WikiHistoryToolbar
            api={api}
            taskId={taskId}
            revision={historyRevision}
            onChanged={() => void refresh()}
          />
        </div>
      )}
    </div>
  );
  const historyButton = (
    <Button
      variant="outline"
      size="sm"
      aria-expanded={historyOpen}
      onClick={() => setHistoryOpen(!historyOpen)}
    >
      <History className="size-3.5" />
      履歴
    </Button>
  );
  const historyPanel = (id: string) =>
    historyOpen && (
      <WikiHistoryPanel
        api={api}
        taskId={taskId}
        pageId={id}
        revision={historyRevision}
        onRestored={() => void refresh()}
        onOpenAnswer={onOpenAnswer}
      />
    );

  const body = (() => {
    if (loadError !== undefined) {
      return (
        <p className="text-destructive text-sm" role="alert">
          {loadError}
        </p>
      );
    }
    if (pages === undefined) {
      return <p className="text-muted-foreground text-sm">読み込み中…</p>;
    }
    if (mode === "new") {
      return (
        <PageEditor
          initial={toDraft()}
          onCancel={() => setMode("view")}
          onSave={async (draft) => {
            const created = await api.wiki.create({
              taskId,
              title: draft.title,
              aliases: parseAliases(draft.aliases),
              body: draft.body,
            });
            await refresh();
            setMode("view");
            onNavigate(created.id);
          }}
        />
      );
    }
    if (pageId === undefined) {
      return (
        <p className="text-muted-foreground text-sm">
          {pages.length === 0
            ? "「新しいノート」から最初のノートを作りましょう。"
            : `${pages.length} 件のノートがあります。左の一覧からノートを選んでください。`}
        </p>
      );
    }
    if (page === undefined) {
      const deleted = deletedPages.find((version) => version.pageId === pageId);
      return (
        <div className="flex flex-col items-start gap-3">
          {deleted === undefined ? (
            <p className="text-muted-foreground">
              このノートは削除されたか、存在しません。
            </p>
          ) : (
            <>
              <h2 className="font-bold text-2xl">{deleted.title}</h2>
              <p className="text-muted-foreground">
                このノートは削除されています。変更履歴から復元できます。
              </p>
              <Button
                size="sm"
                onClick={async () => {
                  await api.wiki.restoreVersion({ taskId, seq: deleted.seq });
                  await refresh();
                }}
              >
                <RotateCcw className="size-3.5" />
                削除前に復元
              </Button>
            </>
          )}
          {deleted !== undefined && historyButton}
          {deleted !== undefined && historyPanel(deleted.pageId)}
          {hasPageChat && openChatButton("質問の履歴を開く")}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate(undefined)}
          >
            <ArrowLeft className="size-4" />
            一覧に戻る
          </Button>
        </div>
      );
    }
    if (mode === "edit") {
      return (
        <PageEditor
          initial={toDraft(page)}
          onCancel={() => setMode("view")}
          onSave={async (draft) => {
            await api.wiki.update({
              id: page.id,
              title: draft.title,
              aliases: parseAliases(draft.aliases),
              body: draft.body,
            });
            await refresh();
            setMode("view");
          }}
        />
      );
    }
    return (
      <article className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {returnTo !== undefined && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onReturn(returnTo)}
            >
              <ArrowLeft className="size-4" />
              回答に戻る
            </Button>
          )}
          <div className="flex-1" />
          {openChatButton("このノートについて質問")}
          {historyButton}
          <Button variant="outline" size="sm" onClick={() => setMode("edit")}>
            <Pencil className="size-3.5" />
            編集
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="ノートを削除"
            onClick={() => setDeleting(true)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
        <WikiPageContent
          page={page}
          onOpenChat={onOpenChat}
          selectionActions={{
            api,
            taskId,
            onAsk: (selected) => {
              setQuote(selected);
              setAskingPageId(page.id);
            },
            onPageCreated: () => void refresh(),
            onOpenPage: onNavigate,
          }}
          terms={noteTerms}
        />
        {historyPanel(page.id)}
        <PageQaList
          api={api}
          taskId={taskId}
          pageId={page.id}
          revision={qaRevision}
        />
        <Dialog
          open={deleting}
          onOpenChange={setDeleting}
          title="ノートを削除しますか？"
          description={`「${page.title}」を削除します。このノートを引用した過去の回答は、そのまま読めます。`}
        >
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(false)}>
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                await api.wiki.delete({ id: page.id });
                setDeleting(false);
                await refresh();
                if (!asking && !hasPageChat) onNavigate(undefined);
              }}
            >
              削除
            </Button>
          </DialogFooter>
        </Dialog>
      </article>
    );
  })();

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside
        className="flex shrink-0 flex-col border-r pt-3"
        style={{ width: WIKI_PAGE_LIST_WIDTH }}
      >
        <WikiPageList
          pages={pages}
          loadError={loadError}
          pageId={pageId}
          onNavigate={onNavigate}
        />
        {deletedPages.length > 0 && (
          <details className="border-t px-2 py-2 text-sm">
            <summary className="cursor-pointer px-2 text-muted-foreground">
              削除したノート（{deletedPages.length}）
            </summary>
            <ul
              aria-label="削除したノート"
              className="mt-1 flex flex-col gap-0.5"
            >
              {deletedPages.map((version) => (
                <li key={version.pageId}>
                  <button
                    type="button"
                    className={cn(
                      "w-full truncate rounded-md px-2 py-1 text-left text-muted-foreground line-through hover:bg-accent",
                      version.pageId === pageId && "bg-accent",
                    )}
                    onClick={() => onNavigate(version.pageId)}
                  >
                    {version.title}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </aside>
      <div
        ref={row}
        className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row"
      >
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
            {header}
            {body}
          </div>
        </div>
        {asking && (
          <SidePanelResizer
            width={sidePanel.width}
            min={sidePanel.min}
            max={sidePanel.max}
            onResize={sidePanel.resize}
            onCommit={sidePanel.commit}
          />
        )}
        {asking && (
          <SideChat
            key={pageId}
            width={sidePanel.width}
            request={{
              kind: "wiki",
              taskId,
              pageId,
              title: page?.title,
              quote,
            }}
            api={api}
            models={models}
            hidden={termPane !== undefined}
            onActivity={() => {
              onChatActivity();
              setQaRevision((revision) => revision + 1);
              // Claude が Wiki のページを編集・作成していれば反映する
              void refresh();
            }}
            onClose={closeChat}
            onOpenWikiPage={(_, id) => onNavigate(id)}
            onOpenWikiPane={(_, id) => openTermPane(id)}
            onWikiPageCreated={() => void refresh()}
          />
        )}
        {asking && termPane !== undefined && (
          <WikiPane
            key={termPane.id}
            api={api}
            width={sidePanel.width}
            taskId={taskId}
            pageId={termPane.pageId}
            onClose={closeTermPane}
            onOpenFull={() => onNavigate(termPane.pageId)}
            onOpenPage={openTermPane}
            onWikiPageCreated={() => void refresh()}
          />
        )}
      </div>
    </div>
  );
};
