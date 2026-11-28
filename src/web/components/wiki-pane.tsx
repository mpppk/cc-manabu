import { BookOpen, X } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { WikiPageQuote } from "../../chat/quote.ts";
import type { WikiPageDto } from "../../router.ts";
import { isPageTerm, normalizeTerm } from "../../wiki/terms.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { useWikiPages } from "../lib/use-wiki-pages.ts";
import { cn } from "../lib/utils.ts";
import { useNoteTermMatcher } from "../lib/wiki-terms.ts";
import { Markdown } from "./markdown.tsx";
import { SelectionPopup, useTextSelection } from "./selection-popup.tsx";
import { Button } from "./ui/button.tsx";
import { WikiTermsContext, type WikiTermsContextValue } from "./wiki-term.tsx";

/** 本文の選択範囲から、質問やページの作成をするための設定。 */
export type WikiSelectionActions = {
  api: ApiClient;
  /** ページを作る Wiki のタスク。 */
  taskId: string;
  /** 選んだ部分を引用して、このページについて質問する。 */
  onAsk?: ((quote: WikiPageQuote) => void) | undefined;
  /** 選んだ語句のページを作ったあとに呼ぶ（一覧を読み直す）。 */
  onPageCreated?: (() => void) | undefined;
  /** 作ったページ（すでにあったページ）を開く。 */
  onOpenPage?: ((pageId: string) => void) | undefined;
};

/** 本文の用語（同じ Wiki の別のノート）から、説明とノートを開けるようにする設定（#210）。 */
export type WikiNoteTerms = {
  /** 同じ Wiki のノート。読み込み中は undefined。 */
  pages: readonly WikiPageDto[] | undefined;
  /** 用語の説明に出すノートを読む。 */
  load: (pageId: string) => Promise<WikiPageDto | undefined>;
  /** 用語のノートを開く（クリック・Enter と、要約のボタン）。 */
  open: (pageId: string) => void;
  /** 要約の、ノートを開くボタンの文言。既定は「サイドパネルで開く」。 */
  openLabel?: string | undefined;
};

type Notice = {
  text: string;
  tone: "info" | "error";
  pageId?: string;
};

/**
 * 用語の照合と、用語の説明・ノートを開くための context（#210）。
 * pageId（閲覧中のノート）自身は照合しない。terms が無ければどちらも undefined。
 */
export const useNoteTerms = (
  terms: WikiNoteTerms | undefined,
  pageId: string,
) => {
  const matcher = useNoteTermMatcher(terms?.pages, pageId);
  const load = terms?.load;
  const openTerm = terms?.open;
  const openLabel = terms?.openLabel;
  const context = useMemo<WikiTermsContextValue | undefined>(
    () =>
      load === undefined || openTerm === undefined
        ? undefined
        : {
            load,
            open: openTerm,
            openPane: openTerm,
            openPaneLabel: openLabel,
          },
    [load, openTerm, openLabel],
  );
  return {
    termMatcher: context === undefined ? undefined : matcher,
    termsContext: context,
  };
};

/**
 * 選択範囲から質問・ノートの作成ができる範囲。ノートの本文と、その Q&A（#205）で使う。
 * attribute を持つ要素の中の選択だけを対象にする。qa なら attribute の値は Q&A の id で、
 * ノートの作成ではその Q&A を資料にする（無ければノートの本文を資料にする）。
 * ノートの作成は画面を移らずに行い、結果を範囲の下に少しのあいだ出す。
 */
export const WikiSelectionArea = ({
  page,
  actions,
  attribute,
  qa = false,
  children,
}: {
  page: Pick<WikiPageDto, "id" | "title">;
  actions: WikiSelectionActions | undefined;
  attribute: string;
  qa?: boolean;
  children: ReactNode;
}) => {
  const container = useRef<HTMLDivElement>(null);
  const selection = useTextSelection(
    container,
    attribute,
    actions !== undefined,
  );
  /** AI で作っている最中のページの語句。 */
  const [generating, setGenerating] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice>();
  useEffect(() => {
    if (notice === undefined) return;
    const timer = setTimeout(() => setNotice(undefined), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const generatePage = async (term: string, qaId: string | undefined) => {
    if (actions === undefined) return;
    setNotice(undefined);
    setGenerating((current) => [...current, term]);
    try {
      const result = await actions.api.wiki.generateFromPage({
        taskId: actions.taskId,
        pageId: page.id,
        term,
        ...(qaId === undefined ? {} : { qaId }),
      });
      actions.onPageCreated?.();
      setNotice({
        tone: "info",
        pageId: result.page.id,
        text: result.created
          ? `「${result.page.title}」のノートを作成しました。`
          : `「${result.page.title}」のノートはすでにあります。`,
      });
    } catch {
      setNotice({
        tone: "error",
        text: `「${term}」のノートを作成できませんでした。もう一度お試しください。`,
      });
    } finally {
      setGenerating((current) => current.filter((t) => t !== term));
    }
  };

  const term = selection?.text.trim();
  const createBlocker =
    term === undefined || !isPageTerm(term)
      ? "1 行・2〜40 文字の語句を選ぶと、ノートを作れます"
      : generating.some((t) => normalizeTerm(t) === normalizeTerm(term))
        ? "この語句のノートを作成しています"
        : undefined;
  const onAsk = actions?.onAsk;

  return (
    <>
      {selection !== undefined && actions !== undefined && (
        <SelectionPopup
          selection={selection}
          ask={{
            onClick:
              onAsk === undefined
                ? undefined
                : () => {
                    onAsk({
                      text: selection.text,
                      sourcePage: { id: page.id, title: page.title },
                    });
                    window.getSelection()?.removeAllRanges();
                  },
            title:
              onAsk === undefined
                ? "ここからは質問できません"
                : "選んだ部分を引用して、このノートについて質問します",
          }}
          createPage={{
            onClick:
              term === undefined || createBlocker !== undefined
                ? undefined
                : () => {
                    void generatePage(
                      term,
                      qa ? selection.sourceId : undefined,
                    );
                    window.getSelection()?.removeAllRanges();
                  },
            title:
              createBlocker ??
              (qa
                ? "選んだ語句のノートを、この Q&A を資料にして AI で作ります（画面は移りません）"
                : "選んだ語句のノートを AI で作ります（画面は移りません）"),
          }}
        />
      )}
      <div ref={container}>{children}</div>
      {generating.length > 0 && (
        <p role="status" className="text-muted-foreground text-xs">
          {generating.map((t) => `「${t}」`).join("")}
          のノートを作成しています…
        </p>
      )}
      {notice !== undefined && (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={cn(
            "flex flex-wrap items-center gap-2 text-xs",
            notice.tone === "error"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {notice.text}
          {notice.pageId !== undefined &&
            notice.pageId !== page.id &&
            actions?.onOpenPage !== undefined && (
              <button
                type="button"
                className="text-primary underline"
                onClick={() => {
                  if (notice.pageId !== undefined) {
                    actions.onOpenPage?.(notice.pageId);
                  }
                }}
              >
                開く
              </button>
            )}
        </p>
      )}
    </>
  );
};

/** Wiki ページの本文。actions があれば、選択範囲から質問・ページの作成ができる。 */
const WikiPageBody = ({
  page,
  actions,
  terms,
}: {
  page: WikiPageDto;
  actions: WikiSelectionActions | undefined;
  terms: WikiNoteTerms | undefined;
}) => {
  const { termMatcher, termsContext } = useNoteTerms(terms, page.id);
  return (
    <WikiSelectionArea
      page={page}
      actions={actions}
      attribute="data-wiki-page-body"
    >
      <div data-wiki-page-body={page.id}>
        <WikiTermsContext.Provider value={termsContext}>
          <Markdown
            text={page.body}
            {...(termMatcher === undefined ? {} : { termMatcher })}
          />
        </WikiTermsContext.Provider>
      </div>
    </WikiSelectionArea>
  );
};

/**
 * Wiki ページの中身（タイトル・自動作成の注記・別名・本文・最終更新）。
 * Wiki 画面と、会話の右側のペインで使う。
 */
export const WikiPageContent = ({
  page,
  onOpenChat,
  compact = false,
  selectionActions,
  terms,
}: {
  page: WikiPageDto;
  /** 自動作成の元になった会話を開く。無ければ「元の回答を開く」を出さない。 */
  onOpenChat?: ((chatId: string) => void) | undefined;
  /** ペイン向けに見出しを小さくする。 */
  compact?: boolean;
  /** 本文の選択範囲から、質問・ページの作成をできるようにする。 */
  selectionActions?: WikiSelectionActions | undefined;
  /** 本文の用語から、説明とノートを開けるようにする（#210）。 */
  terms?: WikiNoteTerms | undefined;
}) => (
  <>
    <h2 className={cn("font-bold", compact ? "text-xl" : "text-2xl")}>
      {page.title}
    </h2>
    {page.origin === "auto" && (
      <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        回答から自動で作成したノートです（編集しても自動で上書きされることはありません）。
        {page.sourceChatId !== null && onOpenChat !== undefined && (
          <button
            type="button"
            className="text-primary underline"
            onClick={() => {
              if (page.sourceChatId !== null) onOpenChat(page.sourceChatId);
            }}
          >
            元の回答を開く
          </button>
        )}
      </p>
    )}
    {page.aliases.length > 0 && (
      <p className="text-muted-foreground text-sm">
        別名: {page.aliases.join("、")}
      </p>
    )}
    {page.body.trim() === "" ? (
      <p className="text-muted-foreground text-sm">本文はまだありません。</p>
    ) : (
      <WikiPageBody page={page} actions={selectionActions} terms={terms} />
    )}
    <p className="text-muted-foreground text-xs">
      最終更新: {new Date(page.updatedAt).toLocaleString("ja-JP")}
    </p>
  </>
);

type State =
  | { status: "loading" }
  | { status: "ready"; page: WikiPageDto }
  | { status: "missing" }
  | { status: "error" };

/**
 * 回答中の用語・引用から開く Wiki ページのペイン。会話の右側（狭い画面では全面）に出す。
 * 開くとペインにフォーカスを移し、Escape か閉じるボタンで閉じる。
 */
export const WikiPane = ({
  api,
  taskId,
  pageId,
  onClose,
  onOpenFull,
  onOpenChat,
  onOpenPage,
  onAskSelection,
  onWikiPageCreated,
  revision = 0,
}: {
  api: ApiClient;
  /** ページを開いた会話のタスク（選択範囲からのページ作成に使う）。 */
  taskId: string;
  pageId: string;
  onClose: () => void;
  /** Wiki 画面でページを開く。 */
  onOpenFull?: (() => void) | undefined;
  /** 自動作成の元になった会話を開く。 */
  onOpenChat?: ((chatId: string) => void) | undefined;
  /** 選択範囲から作ったページを、このペインで開く。 */
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** 本文の選んだ部分を引用して、このページについて質問する。 */
  onAskSelection?: ((quote: WikiPageQuote) => void) | undefined;
  /** 選択範囲からページを作ったあとに呼ぶ。 */
  onWikiPageCreated?: ((taskId: string) => void) | undefined;
  /**
   * 変わるたびにページを読み直す（Claude が会話の中で Wiki を編集したかもしれないとき）。
   * 表示中のページは読み込み中の表示にせず、そのまま差し替える。
   */
  revision?: number;
}) => {
  const [state, setState] = useState<State>({ status: "loading" });
  const panel = useRef<HTMLElement>(null);
  // 本文の用語を照合する、同じ Wiki のノート（#210）。会話で Wiki が変わったら読み直す
  const { pages, refresh: refreshPages } = useWikiPages(api, taskId);
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    void refreshPages();
  }, [revision, refreshPages]);
  const loadTerm = useCallback(
    (id: string) => api.wiki.get({ id }).catch(() => undefined),
    [api],
  );
  const terms = useMemo<WikiNoteTerms | undefined>(
    () =>
      onOpenPage === undefined
        ? undefined
        : { pages, load: loadTerm, open: onOpenPage },
    [pages, loadTerm, onOpenPage],
  );
  useEffect(() => {
    panel.current?.focus();
  }, []);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", page: await api.wiki.get({ id: pageId }) });
    } catch (failure) {
      const code = (failure as { code?: unknown } | undefined)?.code;
      setState({ status: code === "NOT_FOUND" ? "missing" : "error" });
    }
  }, [api, pageId]);
  useEffect(() => {
    void load();
  }, [load]);
  const loaded = useRef(revision);
  useEffect(() => {
    if (loaded.current === revision) return;
    loaded.current = revision;
    api.wiki.get({ id: pageId }).then(
      (page) => setState({ status: "ready", page }),
      (failure) => {
        const code = (failure as { code?: unknown } | undefined)?.code;
        if (code === "NOT_FOUND") setState({ status: "missing" });
      },
    );
  }, [api, pageId, revision]);

  const title = state.status === "ready" ? state.page.title : undefined;

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="ノート"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background outline-none lg:border-l"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
        <div className="min-w-0">
          <p className="font-medium text-sm">Wiki</p>
          {title !== undefined && (
            <p className="truncate text-muted-foreground text-xs" title={title}>
              {title}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onOpenFull !== undefined && (
            <Button variant="outline" size="sm" onClick={onOpenFull}>
              <BookOpen className="size-3.5" />
              Wiki で開く
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="ノートを閉じる"
            onClick={onClose}
          >
            <X aria-hidden />
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-none">
        <div className="flex flex-col gap-3 p-4">
          {state.status === "loading" && (
            <p role="status" className="text-muted-foreground text-sm">
              読み込み中…
            </p>
          )}
          {state.status === "missing" && (
            <p className="text-muted-foreground text-sm">
              このノートは削除されたか、存在しません。
            </p>
          )}
          {state.status === "error" && (
            <div className="flex flex-col items-start gap-2 text-sm">
              <p role="alert" className="text-destructive">
                ノートを読み込めませんでした。
              </p>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                再読み込み
              </Button>
            </div>
          )}
          {state.status === "ready" && (
            <WikiPageContent
              page={state.page}
              onOpenChat={onOpenChat}
              compact
              selectionActions={{
                api,
                taskId,
                onAsk: onAskSelection,
                onPageCreated: () => {
                  void refreshPages();
                  onWikiPageCreated?.(taskId);
                },
                onOpenPage,
              }}
              terms={terms}
            />
          )}
        </div>
      </div>
    </aside>
  );
};
