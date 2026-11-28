import { BookOpen, ExternalLink, LayoutDashboard, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatUIMessage } from "../../chat/chat-service.ts";
import type { ContextUsage } from "../../db/schema.ts";
import type {
  ChatDto,
  EnvironmentDto,
  TaskDto,
  TaskLinkDto,
} from "../../router.ts";
import { branchLabel } from "../lib/groups.ts";
import type { ApiClient } from "../lib/orpc.ts";
import {
  formatDateTime,
  TASK_STATUS_CLASSES,
  TASK_STATUS_LABELS,
} from "../lib/task-status.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";

const formatTokens = (tokens: number) => tokens.toLocaleString("ja-JP");

/** 回答で参照資料として渡した Wiki ノート（新しく参照した順、重複なし）。 */
const referencedPages = (
  messages: readonly ChatUIMessage[],
): { taskId: string; id: string; title: string }[] => {
  const seen = new Map<string, { taskId: string; id: string; title: string }>();
  for (const message of [...messages].reverse()) {
    const wiki = message.metadata?.wiki;
    const taskId = wiki?.taskId ?? wiki?.projectId;
    if (taskId === undefined) continue;
    for (const page of wiki?.pages ?? []) {
      if (!seen.has(page.id)) seen.set(page.id, { taskId, ...page });
    }
  }
  return [...seen.values()];
};

/** カテゴリの表示名。SDK の英語名は、id が分かるものだけ日本語にする。 */
const CATEGORY_LABELS: Record<string, string> = {
  system_prompt: "システム指示",
  system_tools: "ツール",
  system_tools_deferred: "ツール（遅延読み込み）",
  mcp_tools: "MCP ツール",
  mcp_tools_deferred: "MCP ツール（遅延読み込み）",
  mcp_instructions: "MCP の指示",
  custom_agents: "エージェント",
  memory_files: "メモリ（CLAUDE.md など）",
  skills: "スキル",
  messages: "会話履歴",
  autocompact_buffer: "自動圧縮の予備",
  compact_buffer: "圧縮の予備",
  free_space: "空き",
};

const ContextSection = ({
  usage,
}: {
  usage: ContextUsage | null | undefined;
}) => (
  <section aria-labelledby="details-context" className="flex flex-col gap-2">
    <h3 id="details-context" className="font-medium text-sm">
      コンテキスト
    </h3>
    {usage === undefined ? (
      <p className="text-muted-foreground text-sm">読み込み中…</p>
    ) : usage === null ? (
      <p className="text-muted-foreground text-sm" data-testid="context-usage">
        未取得（回答が終わると取得します）
      </p>
    ) : (
      <div className="flex flex-col gap-2" data-testid="context-usage">
        <p className="text-sm">
          <span className="font-medium tabular-nums">
            {formatTokens(usage.totalTokens)}
          </span>
          <span className="text-muted-foreground">
            {" "}
            / {formatTokens(usage.maxTokens)} トークン（
            {usage.percentage.toFixed(1)}%）
          </span>
        </p>
        <div aria-hidden className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              usage.percentage >= 80 ? "bg-amber-500" : "bg-sky-500",
            )}
            style={{ width: `${Math.min(100, usage.percentage)}%` }}
          />
        </div>
        {usage.categories.length > 0 && (
          <table className="w-full text-xs">
            <caption className="sr-only">コンテキストの内訳</caption>
            <tbody>
              {usage.categories.map((category) => (
                <tr
                  key={category.id ?? category.name}
                  className={cn(
                    category.kind !== "used" && "text-muted-foreground",
                  )}
                >
                  <th scope="row" className="py-0.5 text-left font-normal">
                    {(category.id === undefined
                      ? undefined
                      : CATEGORY_LABELS[category.id]) ?? category.name}
                  </th>
                  <td className="py-0.5 text-right tabular-nums">
                    {formatTokens(category.tokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-muted-foreground text-xs">
          {formatDateTime(usage.capturedAt)} の回答のあとに取得（内訳は概算・
          {usage.model}）
        </p>
      </div>
    )}
  </section>
);

/**
 * セッション詳細（#245）。右側のペインに、表示中の会話のコンテキストの使用量・モデル・環境・
 * タスク・参照した Wiki ノートを出す。開くだけで、メッセージの送信や生成はしない。
 */
export const SessionDetails = ({
  api,
  chat,
  task,
  environment,
  onClose,
  onOpenTask,
  onOpenWikiPage,
}: {
  api: ApiClient;
  /** 表示中の会話（メインの会話。分岐を切り替えるとその会話）。 */
  chat: ChatDto;
  task: TaskDto | undefined;
  environment: EnvironmentDto | undefined;
  onClose: () => void;
  onOpenTask?: ((taskId: string) => void) | undefined;
  onOpenWikiPage?: ((taskId: string, pageId: string) => void) | undefined;
}) => {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);
  /** 読み込んだ会話と、その使用量・参照したノート。別の会話のものは出さない。 */
  const [loaded, setLoaded] = useState<{
    chatId: string;
    usage: ContextUsage | null;
    pages: ReturnType<typeof referencedPages>;
  }>();
  const usage = loaded?.chatId === chat.id ? loaded.usage : undefined;
  const pages = loaded?.chatId === chat.id ? loaded.pages : [];
  const [links, setLinks] = useState<TaskLinkDto[]>([]);
  const updatedAt = new Date(chat.updatedAt).getTime();
  const idle = chat.status === "idle" || chat.status === "error";

  // 会話を切り替えたとき・送信や回答で会話が変わったとき・生成が終わったときに読み直す
  const chatId = chat.id;
  useEffect(() => {
    let cancelled = false;
    // 生成が終わったときにも読み直す（idle は依存に入れて、変わったら走らせる）
    void idle;
    void updatedAt;
    Promise.all([
      api.chats.contextUsage({ id: chatId }),
      api.chats.get({ id: chatId }),
    ])
      .then(([nextUsage, { messages }]) => {
        if (cancelled) return;
        setLoaded({
          chatId,
          usage: nextUsage,
          pages: referencedPages(messages as ChatUIMessage[]),
        });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ chatId, usage: null, pages: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [api, chatId, updatedAt, idle]);

  const taskId = task?.id;
  useEffect(() => {
    if (taskId === undefined) {
      setLinks([]);
      return;
    }
    let cancelled = false;
    api.links
      .list({ taskId })
      .then((next) => {
        if (!cancelled) setLinks(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, taskId]);

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="セッション詳細"
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
          <p className="font-medium text-sm">セッション詳細</p>
          <p
            className="truncate text-muted-foreground text-xs"
            title={chat.title}
          >
            {branchLabel(chat)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="セッション詳細を閉じる"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-4">
        <ContextSection usage={usage} />

        <section
          aria-labelledby="details-session"
          className="flex flex-col gap-2"
        >
          <h3 id="details-session" className="font-medium text-sm">
            会話・環境
          </h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">モデル</dt>
            <dd className="min-w-0 break-words">
              {chat.model}
              {chat.effort === null ? "" : `（effort: ${chat.effort}）`}
            </dd>
            <dt className="text-muted-foreground">環境</dt>
            <dd className="min-w-0 break-words">
              {environment?.name ?? "（未所属）"}
            </dd>
            <dt className="text-muted-foreground">作業ディレクトリ</dt>
            <dd className="min-w-0 break-all font-mono text-xs">{chat.cwd}</dd>
          </dl>
        </section>

        <section aria-labelledby="details-task" className="flex flex-col gap-2">
          <h3 id="details-task" className="font-medium text-sm">
            タスク・参照
          </h3>
          {task === undefined ? (
            <p className="text-muted-foreground text-sm">
              このスレッドはタスクに属していません。
            </p>
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {onOpenTask === undefined ? (
                  <span className="font-medium">{task.name}</span>
                ) : (
                  <button
                    type="button"
                    className="flex items-center gap-1 font-medium text-primary hover:underline"
                    onClick={() => onOpenTask(task.id)}
                  >
                    <LayoutDashboard aria-hidden className="size-3.5" />
                    {task.name}
                  </button>
                )}
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs",
                    TASK_STATUS_CLASSES[task.status],
                  )}
                >
                  {TASK_STATUS_LABELS[task.status]}
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words">
                <span className="text-muted-foreground">ゴール: </span>
                {task.nextAction === "" ? "—" : task.nextAction}
              </p>
              {links.length > 0 && (
                <ul aria-label="関連リンク" className="flex flex-col gap-1">
                  {links.map((link) => (
                    <li key={link.id}>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 break-all text-primary hover:underline"
                      >
                        <ExternalLink
                          aria-hidden
                          className="size-3.5 shrink-0"
                        />
                        {link.label ?? link.url}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="flex flex-col gap-1 text-sm">
            <p className="text-muted-foreground text-xs">
              この会話で参照した Wiki ノート
            </p>
            {pages.length === 0 ? (
              <p className="text-muted-foreground text-sm">まだありません。</p>
            ) : (
              <ul
                aria-label="参照した Wiki ノート"
                className="flex flex-col gap-1"
              >
                {pages.map((page) => (
                  <li key={page.id}>
                    <button
                      type="button"
                      className="flex items-center gap-1 text-left text-primary hover:underline disabled:text-foreground disabled:no-underline"
                      disabled={onOpenWikiPage === undefined}
                      onClick={() => onOpenWikiPage?.(page.taskId, page.id)}
                    >
                      <BookOpen aria-hidden className="size-3.5 shrink-0" />
                      {page.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </aside>
  );
};
