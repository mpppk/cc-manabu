import { useChat } from "@ai-sdk/react";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { GitBranch, Pencil, RotateCcw, TextQuote, X } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatUIMessage, Effort } from "../../chat/chat-service.ts";
import { type QuoteData, quotesOf } from "../../chat/quote.ts";
import type { ChatDto } from "../../router.ts";
import { citedPageIds, linkWikiCitations } from "../../wiki/citations.ts";
import {
  createTermMatcher,
  type TermEntry,
  type TermMatch,
} from "../../wiki/term-matcher.ts";
import { OrpcChatTransport } from "../lib/chat-transport.ts";
import { branchLabel } from "../lib/groups.ts";
import type { ImageAttachment } from "../lib/image.ts";
import { requestNotificationPermission } from "../lib/notify.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { pathForWiki } from "../lib/route.ts";
import { formatUsage, totalUsage, usageOf } from "../lib/usage.ts";
import { cn } from "../lib/utils.ts";
import { ApprovalCard } from "./approval-card.tsx";
import { Composer } from "./composer.tsx";
import { Markdown, type WikiLinks } from "./markdown.tsx";
import { imagePartsOf, MessageImages } from "./message-images.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { PromptCacheTimer } from "./prompt-cache-timer.tsx";
import { QueuePanel, type QueueState } from "./queue-panel.tsx";
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
        {quotesOf(message.parts).map((quote, i) => (
          <QuoteBlock
            // biome-ignore lint/suspicious/noArrayIndexKey: パーツの順番は変わらない
            key={i}
            text={quote.text}
          />
        ))}
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
  onBranch,
  onAskSelection,
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
  /** この応答から分岐する（完了した応答だけ）。 */
  onBranch?: () => void;
  /** この応答の中を選択しているとき、選択範囲を引用して質問する（#91）。 */
  onAskSelection?: () => void;
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
    <div className="flex flex-col gap-2" data-assistant-message={message.id}>
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
        {canAct && onBranch !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground text-xs"
            onClick={onBranch}
          >
            <GitBranch className="size-3.5" />
            ここから分岐
          </Button>
        )}
        {canAct && onAskSelection !== undefined && (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 px-2 text-xs"
            // 押したときに選択が外れないようにする
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onAskSelection}
          >
            <TextQuote className="size-3.5" />
            選択範囲について質問
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

/** 質問の対象として引用した回答の一部。 */
const QuoteBlock = ({ text }: { text: string }) => (
  <blockquote className="max-h-40 w-full overflow-y-auto whitespace-pre-wrap border-l-4 border-sky-500/60 bg-muted/50 px-3 py-2 text-left text-muted-foreground text-sm">
    {text}
  </blockquote>
);

/**
 * 回答の中の選択範囲。1 つの完了した回答の中だけを対象にする（#91）。
 * 選択が無い・複数の回答にまたがるときは undefined。
 */
const useAnswerSelection = (enabled: boolean) => {
  const [selection, setSelection] = useState<{
    messageId: string;
    text: string;
  }>();
  useEffect(() => {
    if (!enabled) {
      setSelection(undefined);
      return;
    }
    const update = () => {
      const current = window.getSelection();
      const text = current?.toString() ?? "";
      if (current === null || current.isCollapsed || text.trim() === "") {
        setSelection(undefined);
        return;
      }
      const answerOf = (node: Node | null) =>
        (node instanceof Element ? node : node?.parentElement)?.closest(
          "[data-assistant-message]",
        );
      const anchor = answerOf(current.anchorNode);
      const focus = answerOf(current.focusNode);
      const messageId = anchor?.getAttribute("data-assistant-message");
      setSelection(
        anchor !== undefined &&
          anchor !== null &&
          anchor === focus &&
          messageId !== null &&
          messageId !== undefined
          ? { messageId, text: text.replace(/\n{3,}/g, "\n\n").trim() }
          : undefined,
      );
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [enabled]);
  return selection;
};

/** 同じ会話の分岐を切り替えるメニュー（#76）。 */
const BranchSwitcher = ({
  current,
  branches,
  disabled,
  onSelect,
}: {
  current: ChatDto;
  branches: ChatDto[];
  disabled: boolean;
  onSelect: (chatId: string) => void;
}) => {
  const labelOf = (chat: ChatDto) => {
    const parent = branches.find((b) => b.id === chat.parentId);
    return parent === undefined
      ? branchLabel(chat)
      : `${branchLabel(chat)}（${branchLabel(parent)} から分岐）`;
  };
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <label className="flex items-center gap-2">
        <GitBranch className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">分岐</span>
        <select
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1"
          aria-label="分岐"
          value={current.id}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.value)}
        >
          {[...branches]
            .sort(
              (a, b) =>
                new Date(a.createdAt).getTime() -
                new Date(b.createdAt).getTime(),
            )
            .map((branch) => (
              <option key={branch.id} value={branch.id}>
                {labelOf(branch)}
              </option>
            ))}
        </select>
      </label>
      <span className="text-muted-foreground text-xs">
        会話の履歴は分岐ごとに分かれますが、ファイルへの変更はすべての分岐で共有されます。
      </span>
    </div>
  );
};

/** 分岐元から引き継いだ履歴と、分岐で書いた履歴の境目。 */
const InheritedDivider = ({ parent }: { parent: ChatDto | undefined }) => (
  <div className="flex items-center gap-2 text-muted-foreground text-xs">
    <span className="h-px flex-1 bg-border" />
    <GitBranch className="size-3.5" />
    {parent === undefined
      ? "ここから分岐"
      : `ここまで「${branchLabel(parent)}」から引き継いだ履歴`}
    <span className="h-px flex-1 bg-border" />
  </div>
);

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

/** 予約（#102）を取り直す間隔。 */
const QUEUE_POLL_MS = 1000;

/**
 * 分岐の予約（#102）。予約はサーバが送るので、送られたら（予約が消えた・サーバで生成中になった）
 * onServerSend で画面に映す。
 */
const useQueue = (
  api: ApiClient,
  chatId: string,
  busy: boolean,
  onServerSend: () => void,
) => {
  const [state, setState] = useState<QueueState>();
  const known = useRef(new Set<string>());
  const missed = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onServerSendRef = useRef(onServerSend);
  onServerSendRef.current = onServerSend;

  const refresh = useCallback(async () => {
    const next = await api.queue.list({ chatId }).catch(() => undefined);
    if (next === undefined) return;
    const ids = new Set(next.items.map((item) => item.id));
    if ([...known.current].some((id) => !ids.has(id))) missed.current = true;
    known.current = ids;
    setState((current) =>
      JSON.stringify(current) === JSON.stringify(next) ? current : next,
    );
    if (!busyRef.current && (missed.current || next.active)) {
      missed.current = false;
      onServerSendRef.current();
    }
  }, [api, chatId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), QUEUE_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /** 利用者が取り消した予約は、送られたものとして扱わない。 */
  const forget = (id: string) => {
    known.current.delete(id);
  };
  return { state, refresh, forget };
};

/** 1 つの会話の画面。useChat に oRPC の ChatTransport を渡す。 */
export const ChatView = ({
  api,
  chat,
  initialMessages,
  models,
  onActivity,
  onOpenWikiPage,
  branches = [],
  onSelectBranch,
  focusMessageId,
}: {
  /** 検索結果から開いたときに移動する発言（#115）。 */
  focusMessageId?: string;
  api: ApiClient;
  chat: ChatDto;
  /** 同じ会話の分岐（#76）。2 つ以上あれば切り替えメニューを出す。 */
  branches?: ChatDto[];
  /** 分岐を開く（作った分岐を開くのにも使う）。 */
  onSelectBranch?: (chatId: string) => void;
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
  const {
    messages,
    sendMessage,
    regenerate,
    status,
    stop,
    error,
    setMessages,
    resumeStream,
  } = useChat<ChatUIMessage>({
    id: chat.id,
    messages: initialMessages,
    transport,
    // リロード時に生成中なら、途中から表示する
    resume: true,
    onFinish: () => {
      onActivity?.();
      // 予約があれば、サーバが次を送る
      setTimeout(() => void queue.refresh(), 200);
      // 回答のあとに用語ページが自動で作られるので、少し待ってから取り直す
      setTimeout(refreshTerms, 3000);
    },
  });
  const busy = status === "submitted" || status === "streaming";

  /** サーバが予約を送ったら、保存された会話を読み直して生成の続きを受け取る。 */
  const syncing = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const syncFromServer = async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      const latest = await api.chats.get({ id: chat.id });
      if (busyRef.current) return;
      setMessages(latest.messages as ChatUIMessage[]);
      onActivity?.();
      if (
        latest.chat.status === "running" ||
        latest.chat.status === "awaiting_approval"
      ) {
        await resumeStream();
      }
    } catch {
      // 次の取り直しで追いつく
    } finally {
      syncing.current = false;
    }
  };
  const queue = useQueue(api, chat.id, busy, () => void syncFromServer());
  const queueState = queue.state;
  const queueing =
    busy ||
    (queueState !== undefined &&
      !queueState.paused &&
      queueState.items.some((item) => item.status !== "held"));

  /** 「ここから分岐」で選んだ応答。送信すると分岐を作る。取り消すと元に戻る。 */
  const [branchFrom, setBranchFrom] = useState<string>();
  /** 選択範囲について質問するときの引用（#91）。 */
  const [quote, setQuote] = useState<QuoteData>();
  const [branchError, setBranchError] = useState<string>();
  const selection = useAnswerSelection(!busy && branchFrom === undefined);
  const cancelBranch = () => {
    setBranchFrom(undefined);
    setQuote(undefined);
    setBranchError(undefined);
  };
  const branchIndex =
    branchFrom === undefined
      ? -1
      : messages.findIndex((message) => message.id === branchFrom);
  const shown = branchIndex < 0 ? messages : messages.slice(0, branchIndex + 1);

  // 検索結果から開いた発言へ移動し、しばらく強調する
  const [highlighted, setHighlighted] = useState<string>();
  const focusFound = messages.some((m) => m.id === focusMessageId);
  useEffect(() => {
    if (focusMessageId === undefined || !focusFound) return;
    document
      .querySelector(`[data-message-id="${CSS.escape(focusMessageId)}"]`)
      ?.scrollIntoView({ block: "center" });
    setHighlighted(focusMessageId);
    const timer = setTimeout(() => setHighlighted(undefined), 2500);
    return () => clearTimeout(timer);
  }, [focusMessageId, focusFound]);

  const createBranch = async (
    parentMessageId: string,
    parts: ChatUIMessage["parts"],
  ) => {
    setBranchError(undefined);
    const branchId = crypto.randomUUID();
    try {
      const { model, effort } = settingsRef.current;
      await api.chat.branch({
        parentId: chat.id,
        messageId: parentMessageId,
        branchId,
        message: { id: crypto.randomUUID(), role: "user", parts },
        model,
        ...(effort === undefined ? {} : { effort }),
      });
      cancelBranch();
      onActivity?.();
      onSelectBranch?.(branchId);
    } catch (error) {
      setBranchError(
        error instanceof Error ? error.message : "分岐を作れませんでした。",
      );
    }
  };

  const filePartsOf = (images: ImageAttachment[]) =>
    images.map(({ mediaType, filename, url }) => ({
      type: "file" as const,
      mediaType,
      filename,
      url,
    }));

  const [queueError, setQueueError] = useState<string>();
  const queueAction = async (action: () => Promise<unknown>) => {
    setQueueError(undefined);
    try {
      await action();
    } catch (error) {
      setQueueError(
        error instanceof Error ? error.message : "予約を変更できませんでした。",
      );
    }
    await queue.refresh();
  };

  const enqueue = (text: string, images: ImageAttachment[]) => {
    requestNotificationPermission();
    const parts = [
      ...filePartsOf(images),
      ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ];
    void queueAction(() =>
      api.queue.add({
        chatId: chat.id,
        message: { id: crypto.randomUUID(), role: "user", parts },
      }),
    );
  };

  const submit = (text: string, images: ImageAttachment[]) => {
    if (busy) return;
    requestNotificationPermission();
    const files = filePartsOf(images);
    if (branchFrom !== undefined) {
      void createBranch(branchFrom, [
        ...(quote === undefined
          ? []
          : [{ type: "data-quote" as const, data: quote }]),
        ...files,
        ...(text === "" ? [] : [{ type: "text" as const, text }]),
      ]);
      return;
    }
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
    await queue.refresh();
  };

  return (
    <WikiTermsContext.Provider value={wikiTerms}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
            {branches.length > 1 && (
              <BranchSwitcher
                current={chat}
                branches={branches}
                disabled={branchFrom !== undefined}
                onSelect={(id) => onSelectBranch?.(id)}
              />
            )}
            {shown.map((message, index) => (
              <Fragment key={message.id}>
                {chat.inheritedCount > 0 && index === chat.inheritedCount && (
                  <InheritedDivider
                    parent={branches.find((b) => b.id === chat.parentId)}
                  />
                )}
                <div
                  data-message-id={message.id}
                  className={cn(
                    "rounded-lg transition-shadow",
                    highlighted === message.id &&
                      "ring-2 ring-amber-400 ring-offset-4 ring-offset-background",
                  )}
                >
                  <MessageView
                    message={message}
                    streaming={busy && index === messages.length - 1}
                    canAct={!busy && branchFrom === undefined}
                    isLast={index === messages.length - 1}
                    {...(message.role === "assistant" &&
                    message.metadata?.claudeCode?.lastAssistantUuid !==
                      undefined
                      ? {
                          onBranch: () => {
                            setBranchError(undefined);
                            setQuote(undefined);
                            setBranchFrom(message.id);
                          },
                          ...(selection?.messageId === message.id
                            ? {
                                onAskSelection: () => {
                                  setBranchError(undefined);
                                  setQuote({
                                    text: selection.text,
                                    sourceMessageId: message.id,
                                  });
                                  setBranchFrom(message.id);
                                  window.getSelection()?.removeAllRanges();
                                },
                              }
                            : {}),
                        }
                      : {})}
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
                    {...(onOpenWikiPage === undefined
                      ? {}
                      : { onOpenWikiPage })}
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
                </div>
              </Fragment>
            ))}
            {branchFrom !== undefined && (
              <div
                role="status"
                className="flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-sm"
              >
                <span className="flex flex-1 flex-col gap-2">
                  <span className="flex items-center gap-2">
                    <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                    {quote === undefined
                      ? "この応答の続きとして分岐を作ります。最初のメッセージを送ると分岐ができます（元の会話はそのまま残ります）。"
                      : "選んだ部分について質問します。送ると、この応答の続きとして分岐ができます（元の会話はそのまま残ります）。"}
                  </span>
                  {quote !== undefined && <QuoteBlock text={quote.text} />}
                </span>
                <Button variant="ghost" size="sm" onClick={cancelBranch}>
                  <X className="size-3.5" />
                  取り消す
                </Button>
              </div>
            )}
            {branchError !== undefined && (
              <p className="text-destructive text-sm" role="alert">
                {branchError}
              </p>
            )}
            {error !== undefined && (
              <p className="text-destructive text-sm" role="alert">
                {error.message}
              </p>
            )}
          </div>
        </div>
        <div className="border-t p-4">
          {queueState !== undefined && (
            <QueuePanel
              state={queueState}
              onUpdate={(id, text) =>
                queueAction(() => api.queue.update({ id, text }))
              }
              onRemove={(id) => {
                queue.forget(id);
                return queueAction(() => api.queue.remove({ id }));
              }}
              onRelease={(id) => queueAction(() => api.queue.release({ id }))}
              onResume={() =>
                queueAction(() => api.queue.resume({ chatId: chat.id }))
              }
            />
          )}
          {queueError !== undefined && (
            <p
              className="mx-auto mb-2 max-w-3xl text-destructive text-sm"
              role="alert"
            >
              {queueError}
            </p>
          )}
          <div className="mx-auto mb-2 flex max-w-3xl items-center justify-between gap-2">
            <ModelPicker
              models={models}
              model={settings.model}
              effort={settings.effort}
              disabled={busy}
              onChange={setSettings}
            />
            <span className="flex min-w-0 items-center gap-3">
              <PromptCacheTimer
                messages={messages}
                model={settings.model}
                busy={busy}
              />
              <UsageTotal messages={messages} />
            </span>
          </div>
          <Composer
            busy={busy}
            queueing={queueing && branchFrom === undefined}
            onSubmit={submit}
            onQueue={enqueue}
            onStop={onStop}
          />
        </div>
      </div>
    </WikiTermsContext.Provider>
  );
};
