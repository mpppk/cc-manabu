import { useChat } from "@ai-sdk/react";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { Pencil, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatUIMessage, Effort } from "../../chat/chat-service.ts";
import type { ChatDto } from "../../router.ts";
import { citedPageIds, linkWikiCitations } from "../../wiki/citations.ts";
import {
  createTermMatcher,
  type TermEntry,
  type TermMatch,
} from "../../wiki/term-matcher.ts";
import { OrpcChatTransport } from "../lib/chat-transport.ts";
import type { ImageAttachment } from "../lib/image.ts";
import { requestNotificationPermission } from "../lib/notify.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { pathForWiki } from "../lib/route.ts";
import { formatUsage, totalUsage, usageOf } from "../lib/usage.ts";
import { ApprovalCard } from "./approval-card.tsx";
import { Composer } from "./composer.tsx";
import { Markdown, type WikiLinks } from "./markdown.tsx";
import { imagePartsOf, MessageImages } from "./message-images.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { Reasoning } from "./reasoning.tsx";
import { ToolCard } from "./tool-card.tsx";
import { Button } from "./ui/button.tsx";
import { WikiTermsContext, type WikiTermsContextValue } from "./wiki-term.tsx";

const textOf = (message: ChatUIMessage): string =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");

/** ユーザー発話。生成中でなければ編集できる（それより後ろの会話は消える）。 */
const UserMessage = ({
  message,
  canEdit,
  onEdit,
}: {
  message: ChatUIMessage;
  canEdit: boolean;
  onEdit: (text: string) => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const images = imagePartsOf(message);
  const text = textOf(message);

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-2">
        <MessageImages images={images} />
        <textarea
          className="min-h-24 w-full max-w-[80%] resize-y rounded-2xl border bg-background px-4 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="発話を編集"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          送信すると、この発話より後ろの会話は消えて作り直されます。
          {images.length > 0 && "添付した画像はそのまま送られます。"}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
            キャンセル
          </Button>
          <Button
            size="sm"
            disabled={draft.trim() === ""}
            onClick={() => {
              setEditing(false);
              onEdit(draft.trim());
            }}
          >
            送信
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start justify-end gap-1">
      {canEdit && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label="この発話を編集"
          onClick={() => {
            setDraft(textOf(message));
            setEditing(true);
          }}
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
      <div className="flex max-w-[80%] flex-col items-end gap-2">
        <MessageImages images={images} />
        {text !== "" && (
          <div className="whitespace-pre-wrap rounded-2xl bg-secondary px-4 py-2">
            {text}
          </div>
        )}
      </div>
    </div>
  );
};

const MessageView = ({
  message,
  streaming,
  canAct,
  isLast,
  onRespond,
  onEdit,
  onRegenerate,
  onOpenWikiPage,
  termMatcher,
}: {
  message: ChatUIMessage;
  streaming: boolean;
  /** 生成中でなく、編集・再生成ができるか。 */
  canAct: boolean;
  isLast: boolean;
  onRespond: (
    approvalId: string,
    behavior: "allow" | "deny",
    reason: string | undefined,
  ) => Promise<void>;
  onEdit: (messageId: string, text: string) => void;
  onRegenerate: () => void;
  onOpenWikiPage?: (projectId: string, pageId: string) => void;
  /** 本文の用語を Wiki の用語ページに結び付ける（プロジェクトの会話だけ）。 */
  termMatcher?: (text: string) => TermMatch[];
}) => {
  if (message.role === "user") {
    return (
      <UserMessage
        message={message}
        canEdit={canAct}
        onEdit={(text) => onEdit(message.id, text)}
      />
    );
  }
  const usage = streaming ? undefined : usageOf(message);
  // このターンで参照資料として渡した Wiki ページ。引用されたものだけをリンクにする
  const wiki = message.metadata?.wiki;
  const wikiIds = new Set(wiki?.pages.map((page) => page.id) ?? []);
  const wikiLinks: WikiLinks | undefined =
    wiki === undefined || onOpenWikiPage === undefined
      ? undefined
      : {
          href: (pageId) => pathForWiki(wiki.projectId, pageId),
          onOpen: (pageId) => onOpenWikiPage(wiki.projectId, pageId),
        };
  const cited = citedPageIds(
    message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n"),
    wikiIds,
  ).flatMap((id) => wiki?.pages.filter((page) => page.id === id) ?? []);
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, i) => {
        switch (part.type) {
          case "text":
            return (
              <Markdown
                // biome-ignore lint/suspicious/noArrayIndexKey: パーツの順番は変わらない
                key={i}
                text={linkWikiCitations(part.text, wikiIds)}
                streaming={streaming}
                {...(wikiLinks === undefined ? {} : { wikiLinks })}
                {...(termMatcher === undefined ? {} : { termMatcher })}
              />
            );
          case "reasoning":
            return (
              <Reasoning
                // biome-ignore lint/suspicious/noArrayIndexKey: パーツの順番は変わらない
                key={i}
                text={part.text}
                streaming={streaming && part.state === "streaming"}
              />
            );
          case "dynamic-tool":
            return <ToolCard key={part.toolCallId} part={part} />;
          case "data-approval":
            return (
              <ApprovalCard
                key={part.data.approvalId}
                approval={part.data}
                onRespond={(behavior, reason) =>
                  onRespond(part.data.approvalId, behavior, reason)
                }
              />
            );
          default:
            return null;
        }
      })}
      {!streaming && cited.length > 0 && wikiLinks !== undefined && (
        <nav
          aria-label="参照した Wiki"
          className="flex flex-wrap items-center gap-1.5 text-xs"
        >
          <span className="text-muted-foreground">参照した Wiki:</span>
          {cited.map((page) => (
            <a
              key={page.id}
              href={wikiLinks.href(page.id)}
              className="rounded-full border px-2 py-0.5 hover:bg-accent"
              onClick={(event) => {
                event.preventDefault();
                wikiLinks.onOpen(page.id);
              }}
            >
              {page.title}
            </a>
          ))}
        </nav>
      )}
      <div className="flex items-center gap-2">
        {usage !== undefined && (
          <p className="text-muted-foreground text-xs">
            {message.metadata?.model !== undefined &&
              `${message.metadata.model}・`}
            {formatUsage(usage)}
            {message.metadata?.aborted === true && "・中断"}
          </p>
        )}
        {isLast && canAct && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground text-xs"
            onClick={onRegenerate}
          >
            <RotateCcw className="size-3.5" />
            再生成
          </Button>
        )}
      </div>
    </div>
  );
};

const UsageTotal = ({ messages }: { messages: ChatUIMessage[] }) => {
  const total = totalUsage(messages);
  if (total.inputTokens + total.outputTokens === 0) {
    return null;
  }
  return (
    <span
      className="truncate text-muted-foreground text-xs"
      title="この会話の合計"
    >
      合計 {formatUsage(total)}
    </span>
  );
};

/** 用語の照合を取り直す間隔（自動作成・編集されたページを反映する）。 */
const TERMS_REFRESH_MS = 10_000;

/** プロジェクトの用語ページ（タイトルと別名）から、本文の用語の照合を作る。 */
const useProjectTerms = (api: ApiClient, projectId: string | null) => {
  const [entries, setEntries] = useState<TermEntry[]>([]);
  const refreshTerms = useCallback(() => {
    if (projectId === null) return;
    api.wiki
      .list({ projectId })
      .then((pages) => {
        const next = pages.map((page) => ({
          pageId: page.id,
          names: [page.title, ...page.aliases],
        }));
        // 変わっていなければ照合を作り直さない（本文の再描画を避ける）
        setEntries((current) =>
          JSON.stringify(current) === JSON.stringify(next) ? current : next,
        );
      })
      .catch(() => {});
  }, [api, projectId]);
  useEffect(() => {
    refreshTerms();
    const timer = setInterval(refreshTerms, TERMS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshTerms]);
  const termMatcher = useMemo(
    () =>
      projectId === null || entries.length === 0
        ? undefined
        : createTermMatcher(entries),
    [projectId, entries],
  );
  return { termMatcher, refreshTerms };
};

/** 1 つの会話の画面。useChat に oRPC の ChatTransport を渡す。 */
export const ChatView = ({
  api,
  chat,
  initialMessages,
  models,
  onActivity,
  onOpenWikiPage,
}: {
  api: ApiClient;
  chat: ChatDto;
  initialMessages: ChatUIMessage[];
  /** 選べるモデル（system.status から）。 */
  models: ModelInfo[];
  /** 送信・完了など、一覧の表示（タイトル・状態）が変わりうるときに呼ぶ。 */
  onActivity?: () => void;
  /** 回答から引用された Wiki ページを開く。 */
  onOpenWikiPage?: (projectId: string, pageId: string) => void;
}) => {
  const [settings, setSettings] = useState<{
    model: string;
    effort: Effort | null;
  }>({ model: chat.model, effort: (chat.effort as Effort | null) ?? null });
  // transport は作り直さず、送信時に最新の設定を読む
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const { termMatcher, refreshTerms } = useProjectTerms(api, chat.projectId);
  const wikiTerms = useMemo<WikiTermsContextValue | undefined>(
    () =>
      chat.projectId === null || onOpenWikiPage === undefined
        ? undefined
        : {
            load: (pageId) =>
              api.wiki.get({ id: pageId }).catch(() => undefined),
            open: (pageId) =>
              chat.projectId !== null && onOpenWikiPage(chat.projectId, pageId),
          },
    [api, chat.projectId, onOpenWikiPage],
  );
  const transport = useMemo(
    () => new OrpcChatTransport(api, () => settingsRef.current),
    [api],
  );
  const { messages, sendMessage, regenerate, status, stop, error } =
    useChat<ChatUIMessage>({
      id: chat.id,
      messages: initialMessages,
      transport,
      // リロード時に生成中なら、途中から表示する
      resume: true,
      onFinish: () => {
        onActivity?.();
        // 回答のあとに用語ページが自動で作られるので、少し待ってから取り直す
        setTimeout(refreshTerms, 3000);
      },
    });
  const busy = status === "submitted" || status === "streaming";

  const submit = (text: string, images: ImageAttachment[]) => {
    if (busy) return;
    requestNotificationPermission();
    const files = images.map(({ mediaType, filename, url }) => ({
      type: "file" as const,
      mediaType,
      filename,
      url,
    }));
    void sendMessage(text === "" ? { files } : { text, files }).then(() =>
      onActivity?.(),
    );
    // タイトルと状態（生成中）をすぐ一覧に反映する
    setTimeout(() => onActivity?.(), 300);
  };

  const onStop = async () => {
    // サーバ側の生成を止めてから、購読を切る
    await api.chat.stop({ chatId: chat.id });
    await stop();
  };

  return (
    <WikiTermsContext.Provider value={wikiTerms}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
            {messages.map((message, index) => (
              <MessageView
                key={message.id}
                message={message}
                streaming={busy && index === messages.length - 1}
                canAct={!busy}
                isLast={index === messages.length - 1}
                onEdit={(messageId, text) => {
                  // 画像はサーバでもそのまま送られる。表示からも消えないように付け直す
                  const files = imagePartsOf(message);
                  void sendMessage({ text, files, messageId }).then(() =>
                    onActivity?.(),
                  );
                }}
                onRegenerate={() => {
                  void regenerate().then(() => onActivity?.());
                }}
                {...(onOpenWikiPage === undefined ? {} : { onOpenWikiPage })}
                {...(termMatcher === undefined ? {} : { termMatcher })}
                onRespond={async (approvalId, behavior, reason) => {
                  await api.approvals.respond({
                    chatId: chat.id,
                    approvalId,
                    behavior,
                    ...(reason === undefined ? {} : { message: reason }),
                  });
                  onActivity?.();
                }}
              />
            ))}
            {error !== undefined && (
              <p className="text-destructive text-sm" role="alert">
                {error.message}
              </p>
            )}
          </div>
        </div>
        <div className="border-t p-4">
          <div className="mx-auto mb-2 flex max-w-3xl items-center justify-between gap-2">
            <ModelPicker
              models={models}
              model={settings.model}
              effort={settings.effort}
              disabled={busy}
              onChange={setSettings}
            />
            <UsageTotal messages={messages} />
          </div>
          <Composer busy={busy} onSubmit={submit} onStop={onStop} />
        </div>
      </div>
    </WikiTermsContext.Provider>
  );
};
