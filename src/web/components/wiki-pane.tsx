import { BookOpen, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WikiPageDto } from "../../router.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { cn } from "../lib/utils.ts";
import { Markdown } from "./markdown.tsx";
import { Button } from "./ui/button.tsx";

/**
 * Wiki ページの中身（タイトル・自動作成の注記・別名・本文・最終更新）。
 * Wiki 画面と、会話の右側のペインで使う。
 */
export const WikiPageContent = ({
  page,
  onOpenChat,
  compact = false,
}: {
  page: WikiPageDto;
  /** 自動作成の元になった会話を開く。無ければ「元の回答を開く」を出さない。 */
  onOpenChat?: ((chatId: string) => void) | undefined;
  /** ペイン向けに見出しを小さくする。 */
  compact?: boolean;
}) => (
  <>
    <h2 className={cn("font-bold", compact ? "text-xl" : "text-2xl")}>
      {page.title}
    </h2>
    {page.origin === "auto" && (
      <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        回答から自動で作成したページです（編集しても自動で上書きされることはありません）。
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
      <Markdown text={page.body} />
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
  pageId,
  onClose,
  onOpenFull,
  onOpenChat,
}: {
  api: ApiClient;
  pageId: string;
  onClose: () => void;
  /** Wiki 画面でページを開く。 */
  onOpenFull?: (() => void) | undefined;
  /** 自動作成の元になった会話を開く。 */
  onOpenChat?: ((chatId: string) => void) | undefined;
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

  const title = state.status === "ready" ? state.page.title : undefined;

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="Wiki ページ"
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
            aria-label="Wiki ページを閉じる"
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
              このページは削除されたか、存在しません。
            </p>
          )}
          {state.status === "error" && (
            <div className="flex flex-col items-start gap-2 text-sm">
              <p role="alert" className="text-destructive">
                Wiki ページを読み込めませんでした。
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
            />
          )}
        </div>
      </div>
    </aside>
  );
};
