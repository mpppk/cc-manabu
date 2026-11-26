import { BookOpen, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WikiPageQuote } from "../../chat/quote.ts";
import type { WikiPageDto } from "../../router.ts";
import { isPageTerm, normalizeTerm } from "../../wiki/terms.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { cn } from "../lib/utils.ts";
import { Markdown } from "./markdown.tsx";
import { SelectionPopup, useTextSelection } from "./selection-popup.tsx";
import { Button } from "./ui/button.tsx";

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

type Notice = {
  text: string;
  tone: "info" | "error";
  pageId?: string;
};

/**
 * Wiki ページの本文。actions があれば、選択範囲から質問・ページの作成ができる。
 * ページの作成は画面を移らずに行い、結果を本文の下に少しのあいだ出す。
 */
const WikiPageBody = ({
  page,
  actions,
}: {
  page: WikiPageDto;
  actions: WikiSelectionActions | undefined;
}) => {
  const container = useRef<HTMLDivElement>(null);
  const selection = useTextSelection(
    container,
    "data-wiki-page-body",
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

  const generatePage = async (term: string) => {
    if (actions === undefined) return;
    setNotice(undefined);
    setGenerating((current) => [...current, term]);
    try {
      const result = await actions.api.wiki.generateFromPage({
        taskId: actions.taskId,
        pageId: page.id,
        term,
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
                    void generatePage(term);
                    window.getSelection()?.removeAllRanges();
                  },
            title:
              createBlocker ??
              "選んだ語句のノートを AI で作ります（画面は移りません）",
          }}
        />
      )}
      <div ref={container} data-wiki-page-body={page.id}>
        <Markdown text={page.body} />
      </div>
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

/**
 * Wiki ページの中身（タイトル・自動作成の注記・別名・本文・最終更新）。
 * Wiki 画面と、会話の右側のペインで使う。
 */
export const WikiPageContent = ({
  page,
  onOpenChat,
  compact = false,
  selectionActions,
}: {
  page: WikiPageDto;
  /** 自動作成の元になった会話を開く。無ければ「元の回答を開く」を出さない。 */
  onOpenChat?: ((chatId: string) => void) | undefined;
  /** ペイン向けに見出しを小さくする。 */
  compact?: boolean;
  /** 本文の選択範囲から、質問・ページの作成をできるようにする。 */
  selectionActions?: WikiSelectionActions | undefined;
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
      <WikiPageBody page={page} actions={selectionActions} />
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
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background outline-none max-lg:fixed max-lg:inset-0 max-lg:z-30 lg:w-[42%] lg:min-w-80 lg:max-w-xl lg:flex-none lg:border-l"
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
      <div className="flex-1 overflow-y-auto">
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
                onPageCreated: () => onWikiPageCreated?.(taskId),
                onOpenPage,
              }}
            />
          )}
        </div>
      </div>
    </aside>
  );
};
