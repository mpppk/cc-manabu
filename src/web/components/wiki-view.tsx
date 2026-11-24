import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  ArrowLeft,
  FilePlus,
  MessageCircle,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { WikiPageDto } from "../../router.ts";
import { searchPages } from "../../wiki/match.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { SideChat } from "./chat-workspace.tsx";
import { Markdown } from "./markdown.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogFooter } from "./ui/dialog.tsx";

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

const AutoBadge = () => (
  <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-normal text-[10px] text-sky-700 dark:text-sky-400">
    自動作成
  </span>
);

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
        aria-label="ページのタイトル"
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

/** プロジェクトの Wiki（一覧・検索・閲覧・作成・編集・削除）。 */
export const WikiView = ({
  api,
  projectId,
  projectName,
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
  initialDraft,
}: {
  /** 回答の選択範囲から作るときの下書き（#121）。あれば作成画面で開く。 */
  initialDraft?: { title: string; body: string } | undefined;
  api: ApiClient;
  projectId: string;
  projectName: string;
  /** Wiki の名前（無ければプロジェクト名を使う）。 */
  wikiName?: string | undefined;
  /** 同じ Wiki を使っている、ほかのプロジェクトの名前。 */
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
}) => {
  const [pages, setPages] = useState<WikiPageDto[]>();
  const [loadError, setLoadError] = useState<string>();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"view" | "new" | "edit">(
    initialDraft === undefined ? "view" : "new",
  );
  const [deleting, setDeleting] = useState(false);
  const [askingPageId, setAskingPageId] = useState<string>();
  const askButton = useRef<HTMLButtonElement>(null);
  const closeChat = () => {
    setAskingPageId(undefined);
    requestAnimationFrame(() => askButton.current?.focus());
  };

  const refresh = useCallback(async () => {
    try {
      setPages(await api.wiki.list({ projectId }));
      setLoadError(undefined);
    } catch {
      setLoadError("Wiki を読み込めませんでした。");
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ページを移ったら閲覧に戻す（開いたときは下書きの作成画面のまま）
  const openedPageId = useRef(pageId);
  useEffect(() => {
    if (openedPageId.current === pageId) return;
    openedPageId.current = pageId;
    setMode("view");
    setAskingPageId(undefined);
  }, [pageId]);

  const page = pages?.find((p) => p.id === pageId);
  const asking = pageId !== undefined && askingPageId === pageId;
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
          {wikiName === undefined || wikiName === projectName
            ? `${projectName} の Wiki`
            : `Wiki: ${wikiName}`}
        </h1>
        {sharedWith.length > 0 && (
          <span className="text-muted-foreground text-xs">
            {sharedWith.map((name) => `「${name}」`).join("")}
            と共有している Wiki
            です。ページの変更はすべてのプロジェクトに反映されます。
          </span>
        )}
        <span className="text-muted-foreground text-xs">
          回答からの用語ページの自動作成: {autoTerms ? "オン" : "オフ"}
          （プロジェクトの設定で変更できます）
        </span>
      </div>
      {mode === "view" && (
        <Button size="sm" onClick={() => setMode("new")}>
          <FilePlus className="size-4" />
          新しいページ
        </Button>
      )}
    </div>
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
          initial={
            initialDraft === undefined
              ? toDraft()
              : { ...initialDraft, aliases: "" }
          }
          onCancel={() =>
            // 回答から開いた作成画面は、取り消したら回答に戻る
            initialDraft !== undefined && returnTo !== undefined
              ? onReturn(returnTo)
              : setMode("view")
          }
          onSave={async (draft) => {
            const created = await api.wiki.create({
              projectId,
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
      const found = searchPages(pages, query);
      return (
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5">
            <Search className="size-4 text-muted-foreground" />
            <input
              className="flex-1 bg-transparent text-sm outline-none"
              aria-label="Wiki を検索"
              placeholder="タイトル・別名・本文で検索"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {found.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {pages.length === 0
                ? "まだページがありません。「新しいページ」から作れます。"
                : "一致するページはありません。"}
            </p>
          ) : (
            <ul aria-label="Wiki のページ" className="flex flex-col gap-1">
              {found.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start rounded-md px-3 py-2 text-left hover:bg-accent"
                    onClick={() => onNavigate(p.id)}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      {p.title}
                      {p.origin === "auto" && <AutoBadge />}
                    </span>
                    {p.aliases.length > 0 && (
                      <span className="text-muted-foreground text-xs">
                        別名: {p.aliases.join("、")}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    if (page === undefined) {
      return (
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground">
            このページは削除されたか、存在しません。
          </p>
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onNavigate(undefined)}
          >
            <ArrowLeft className="size-4" />
            一覧
          </Button>
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
          {openChatButton("このページについて質問")}
          <Button variant="outline" size="sm" onClick={() => setMode("edit")}>
            <Pencil className="size-3.5" />
            編集
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="ページを削除"
            onClick={() => setDeleting(true)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
        <h2 className="font-bold text-2xl">{page.title}</h2>
        {page.origin === "auto" && (
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <AutoBadge />
            回答から自動で作成したページです（編集しても自動で上書きされることはありません）。
            {page.sourceChatId !== null && (
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
          <p className="text-muted-foreground text-sm">
            本文はまだありません。
          </p>
        ) : (
          <Markdown text={page.body} />
        )}
        <p className="text-muted-foreground text-xs">
          最終更新: {new Date(page.updatedAt).toLocaleString("ja-JP")}
        </p>
        <Dialog
          open={deleting}
          onOpenChange={setDeleting}
          title="ページを削除しますか？"
          description={`「${page.title}」を削除します。このページを引用した過去の回答は、そのまま読めます。`}
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
          {header}
          {body}
        </div>
      </div>
      {asking && (
        <SideChat
          key={pageId}
          request={{ kind: "wiki", projectId, pageId, title: page?.title }}
          api={api}
          models={models}
          onActivity={onChatActivity}
          onClose={closeChat}
          onOpenWikiPage={(_, id) => onNavigate(id)}
        />
      )}
    </div>
  );
};
