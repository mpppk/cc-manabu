import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { MessageHit, Snippet } from "../../db/search-repository.ts";
import type { ChatDto } from "../../router.ts";
import { branchLabel, groupChats } from "../lib/groups.ts";
import type { ApiClient } from "../lib/orpc.ts";

export type SearchResult = Awaited<ReturnType<ApiClient["search"]["query"]>>;

const DEBOUNCE_MS = 250;

/** 検索欄。入力が止まったら探す。 */
export const SearchBox = ({
  id,
  value,
  onChange,
  onClose,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** 欄を閉じる。restoreFocus なら検索ボタンにフォーカスを戻す。 */
  onClose: (restoreFocus: boolean) => void;
}) => {
  const close = (restoreFocus: boolean) => {
    onChange("");
    onClose(restoreFocus);
  };
  return (
    <div id={id} className="relative px-3 pb-2">
      <Search className="pointer-events-none absolute top-2 left-5 size-4 text-muted-foreground" />
      <input
        type="search"
        className="h-8 w-full min-w-0 rounded-md border bg-background pr-7 pl-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
        placeholder="会話を検索"
        aria-label="会話を検索"
        // biome-ignore lint/a11y/noAutofocus: 検索ボタンを押した直後に入力できるようにする
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") close(true);
        }}
        onBlur={(event) => {
          // 何も入れずに離れたら閉じる（消すボタンへの移動は除く）
          const next = event.relatedTarget;
          if (
            value === "" &&
            !(
              next instanceof Node &&
              event.currentTarget.parentElement?.contains(next)
            )
          ) {
            close(false);
          }
        }}
      />
      {value !== "" && (
        <button
          type="button"
          className="absolute top-2 right-5 text-muted-foreground hover:text-foreground"
          aria-label="検索を消す"
          onClick={() => close(true)}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
};

/** 入力が止まってから検索する。 */
export const useSearch = (
  query: string,
  search: (q: string) => Promise<SearchResult>,
) => {
  const [result, setResult] = useState<{ q: string; result: SearchResult }>();
  const [error, setError] = useState<string>();
  const q = query.trim();
  useEffect(() => {
    if (q === "") {
      setResult(undefined);
      setError(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      search(q)
        .then((next) => {
          if (cancelled) return;
          setError(undefined);
          setResult({ q, result: next });
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setError(e instanceof Error ? e.message : "検索できませんでした。");
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, search]);
  return {
    result: result?.q === q ? result.result : undefined,
    error,
  };
};

const SnippetText = ({ snippet }: { snippet: Snippet }) => (
  <span className="line-clamp-3 break-words text-muted-foreground text-xs">
    {snippet.before}
    <mark className="rounded-sm bg-amber-300/60 px-0.5 text-foreground dark:bg-amber-500/40">
      {snippet.match}
    </mark>
    {snippet.after}
  </span>
);

const asciiLower = (text: string) =>
  text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** 一致箇所を強調する（英字の大文字・小文字は区別しない）。 */
const Highlighted = ({ text, query }: { text: string; query: string }) => {
  const q = query.trim();
  const index = asciiLower(text).indexOf(asciiLower(q));
  if (q === "" || index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-sm bg-amber-300/60 px-0.5 dark:bg-amber-500/40">
        {text.slice(index, index + q.length)}
      </mark>
      {text.slice(index + q.length)}
    </>
  );
};

/** 検索結果（#115）。会話ごとにまとめ、一致した発言の抜粋を出す。 */
export const SearchResults = ({
  chats,
  query,
  result,
  error,
  onOpen,
}: {
  chats: ChatDto[];
  query: string;
  result: SearchResult | undefined;
  error: string | undefined;
  onOpen: (chatId: string, messageId?: string) => void;
}) => {
  if (error !== undefined) {
    return (
      <p className="px-2 py-4 text-destructive text-sm" role="alert">
        {error}
      </p>
    );
  }
  if (result === undefined) {
    return <p className="px-2 py-4 text-muted-foreground text-sm">検索中…</p>;
  }
  const groups = new Map(groupChats(chats).map((g) => [g.groupId, g]));
  const order: string[] = [];
  const hits = new Map<string, MessageHit[]>();
  const titled = new Set<string>();
  for (const title of result.titles) {
    if (!order.includes(title.groupId)) order.push(title.groupId);
    titled.add(title.groupId);
  }
  for (const hit of result.messages) {
    if (!order.includes(hit.groupId)) order.push(hit.groupId);
    hits.set(hit.groupId, [...(hits.get(hit.groupId) ?? []), hit]);
  }
  const shown = order.filter((groupId) => groups.has(groupId));
  if (shown.length === 0) {
    return (
      <p className="px-2 py-4 text-muted-foreground text-sm">
        見つかりませんでした。
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2" aria-label="検索結果">
      {shown.map((groupId) => {
        const group = groups.get(groupId);
        if (group === undefined) return null;
        const title = group.primary.title || "新しい会話";
        return (
          <li key={groupId} className="flex flex-col gap-0.5">
            <button
              type="button"
              className="truncate rounded-md px-2 py-1 text-left font-medium text-sm hover:bg-sidebar-accent"
              onClick={() => onOpen(group.primary.id)}
            >
              {titled.has(groupId) ? (
                <Highlighted text={title} query={query} />
              ) : (
                title
              )}
            </button>
            {(hits.get(groupId) ?? []).slice(0, 5).map((hit) => {
              const chat = group.branches.find((c) => c.id === hit.chatId);
              const branch =
                group.branches.length > 1 && chat !== undefined
                  ? `・${branchLabel(chat)}`
                  : "";
              return (
                <button
                  key={hit.messageId}
                  type="button"
                  className="flex flex-col gap-0.5 rounded-md py-1 pr-2 pl-4 text-left hover:bg-sidebar-accent"
                  onClick={() => onOpen(hit.chatId, hit.messageId)}
                >
                  <span className="text-[10px] text-muted-foreground">
                    {hit.role === "user" ? "あなた" : "回答"}
                    {branch}
                  </span>
                  <SnippetText snippet={hit.snippet} />
                </button>
              );
            })}
          </li>
        );
      })}
    </ul>
  );
};
