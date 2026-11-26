import { BookOpen, PanelRight } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { WikiPageDto } from "../../router.ts";

/** 回答中の用語から Wiki を引くための関数（ChatView が用意する）。 */
export type WikiTermsContextValue = {
  /** ページの最新の内容。消されていれば undefined。 */
  load: (pageId: string) => Promise<WikiPageDto | undefined>;
  /** Wiki のページを開く（Wiki 画面へ移る）。 */
  open: (pageId: string) => void;
  /**
   * 会話の右側（サイドパネル）でページの本文を開く。あればクリック・Enter と要約の
   * 「サイドパネルで開く」でパネルを開き（#168）、無ければ要約を固定して開く。
   */
  openPane?: ((pageId: string) => void) | undefined;
};

export const WikiTermsContext = createContext<
  WikiTermsContextValue | undefined
>(undefined);

/** 要約に使う本文の先頭（見出しや Markdown の記号を除いた平文）。 */
export const summaryOf = (body: string, max = 160): string => {
  const text = body
    .split("\n")
    .filter((line) => !/^\s*(#|```|---)/.test(line))
    .join(" ")
    .replace(/[*_`>#[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
};

type State =
  | { status: "loading" }
  | { status: "ready"; page: WikiPageDto }
  | { status: "missing" };

/** ホバーで開くまでの時間（ポインタが通り過ぎただけでは開かない）。 */
const HOVER_DELAY_MS = 300;

/**
 * 回答中の用語。ホバー・フォーカスで要約を出し、クリック・タップ・Enter で右側のサイドパネルに
 * ページの本文を開く（パネルが無ければ要約を固定して開く）。要約からもサイドパネルで開け、
 * Wiki 画面へはサイドパネルの「Wiki で開く」から移る。
 */
export const WikiTerm = ({
  pageId,
  children,
}: {
  pageId: string;
  children: ReactNode;
}) => {
  const context = useContext(WikiTermsContext);
  const [open, setOpen] = useState<"hover" | "pinned">();
  const [state, setState] = useState<State>({ status: "loading" });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const root = useRef<HTMLSpanElement>(null);
  const cardId = useId();

  const isOpen = open !== undefined;

  // 開くたびに最新の説明を取り直す（編集・削除を反映する）
  useEffect(() => {
    if (!isOpen || context === undefined) return;
    let cancelled = false;
    setState({ status: "loading" });
    context
      .load(pageId)
      .then((page) => {
        if (!cancelled) {
          setState(
            page === undefined
              ? { status: "missing" }
              : { status: "ready", page },
          );
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, context, pageId]);

  // 固定して開いているときは、外側を押すと閉じる
  useEffect(() => {
    if (open !== "pinned") return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(undefined);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (context === undefined) {
    return <>{children}</>;
  }

  const showOnHover = () => {
    clearTimeout(timer.current);
    if (open === undefined) {
      timer.current = setTimeout(() => setOpen("hover"), HOVER_DELAY_MS);
    }
  };
  const hideOnLeave = () => {
    clearTimeout(timer.current);
    if (open === "hover") {
      timer.current = setTimeout(() => setOpen(undefined), HOVER_DELAY_MS);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 中のボタンと説明をまとめてホバー・フォーカスの範囲にするための入れ物
    <span
      ref={root}
      className="relative inline"
      onMouseEnter={showOnHover}
      onMouseLeave={hideOnLeave}
      onBlur={(event) => {
        if (
          open === "hover" &&
          !root.current?.contains(event.relatedTarget as Node | null)
        ) {
          setOpen(undefined);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(undefined);
      }}
    >
      <button
        type="button"
        data-wiki-term={pageId}
        className="cursor-help underline decoration-sky-500 decoration-dotted underline-offset-2"
        aria-expanded={open !== undefined}
        aria-controls={open === undefined ? undefined : cardId}
        onFocus={() => {
          if (open === undefined) setOpen("hover");
        }}
        onClick={() => {
          clearTimeout(timer.current);
          if (context.openPane !== undefined) {
            setOpen(undefined);
            context.openPane(pageId);
          } else {
            setOpen(open === "pinned" ? undefined : "pinned");
          }
        }}
      >
        {children}
      </button>
      {open !== undefined && (
        <span
          id={cardId}
          role="dialog"
          aria-label="用語の説明"
          className="absolute top-full left-0 z-30 mt-1 flex w-72 flex-col gap-2 rounded-md border bg-background p-3 text-left font-normal text-sm shadow-lg"
        >
          {state.status === "loading" && (
            <span className="text-muted-foreground text-xs">読み込み中…</span>
          )}
          {state.status === "missing" && (
            <span className="text-muted-foreground text-xs">
              この用語のノートは削除されました。
            </span>
          )}
          {state.status === "ready" && (
            <>
              <span className="font-semibold">{state.page.title}</span>
              <span className="text-muted-foreground">
                {summaryOf(state.page.body) || "説明はまだありません。"}
              </span>
              {context.openPane === undefined ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 self-start text-primary text-xs underline"
                  onClick={() => {
                    setOpen(undefined);
                    context.open(pageId);
                  }}
                >
                  <BookOpen className="size-3.5" />
                  Wiki で開く
                </button>
              ) : (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 self-start text-primary text-xs underline"
                  onClick={() => {
                    clearTimeout(timer.current);
                    setOpen(undefined);
                    context.openPane?.(pageId);
                  }}
                >
                  <PanelRight className="size-3.5" />
                  サイドパネルで開く
                </button>
              )}
            </>
          )}
        </span>
      )}
    </span>
  );
};
