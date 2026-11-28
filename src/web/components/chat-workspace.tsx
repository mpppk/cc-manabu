import { X } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  type ChatDefaults,
  resolveChatDefaults,
} from "../../chat/chat-defaults.ts";
import type { ChatUIMessage } from "../../chat/chat-service.ts";
import type { AnswerQuote, WikiPageQuote } from "../../chat/quote.ts";
import type { ChatDto, TaskDto } from "../../router.ts";
import { ChatDefaultsContext } from "../lib/chat-defaults.ts";
import type { SendSettings } from "../lib/chat-transport.ts";
import { useColumns } from "../lib/columns.ts";
import { branchLabel } from "../lib/groups.ts";
import { type ImageAttachment, imageFileParts } from "../lib/image.ts";
import { requestNotificationPermission } from "../lib/notify.ts";
import { ChatView, type ChatViewProps, QuoteBlock } from "./chat-view.tsx";
import { ColumnStack } from "./column-stack.tsx";
import { Composer } from "./composer.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { SessionDetails } from "./session-details.tsx";
import { Button } from "./ui/button.tsx";
import { WikiPane } from "./wiki-pane.tsx";

type SideDraft = {
  parentId: string;
  quote: AnswerQuote;
  settings: SendSettings;
};
type BranchRequest = { kind: "branch"; id: string; draft?: SideDraft };
/** Wiki ページにひも付く会話。quote があれば、次の質問に添える。 */
export type WikiRequest = {
  kind: "wiki";
  taskId: string;
  pageId: string;
  title?: string | undefined;
  quote?: WikiPageQuote | undefined;
};
type SideConversation = { chat: ChatDto; messages: ChatUIMessage[] };
/** 分岐した会話、または Wiki ページにひも付く会話をサイドで開く。 */
export const SideChat = ({
  request,
  onClose,
  api,
  models,
  onConversation,
  quoteNotice,
  ...callbacks
}: Pick<
  ChatViewProps,
  | "api"
  | "models"
  | "onActivity"
  | "onOpenWikiPage"
  | "onOpenWikiPane"
  | "onWikiPageCreated"
  | "onLocateQuoteElsewhere"
> & {
  request: BranchRequest | WikiRequest;
  onClose: () => void;
  /** 開いている会話が変わったとき（閉じたときは undefined。#234）。 */
  onConversation?: ((chatId: string | undefined) => void) | undefined;
  /**
   * 引用元を示そうとしたが、メインで開いている会話に引用元が無かったとき（#239）。
   * onOpenSource があれば、引用元の会話をメインで開ける。
   */
  quoteNotice?:
    | { onOpenSource: (() => void) | undefined; onDismiss: () => void }
    | undefined;
}) => {
  const wiki = request.kind === "wiki" ? request : undefined;
  const taskId = wiki?.taskId;
  const pageId = wiki?.pageId;
  // Wiki ページの本文から選んだ引用。開いたまま別の部分を選んだら差し替える
  const requestedQuote = wiki?.quote;
  const [wikiQuote, setWikiQuote] = useState(requestedQuote);
  useEffect(() => setWikiQuote(requestedQuote), [requestedQuote]);
  const draft = request.kind === "branch" ? request.draft : undefined;
  const branchId = request.kind === "branch" ? request.id : undefined;
  const [submittedId, setSubmittedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [conversation, setConversation] = useState<
    SideConversation | null | undefined
  >(draft === undefined ? undefined : null);
  const [error, setError] = useState<string>();
  // Wiki ページについての最初の質問は、最後に選んだモデルと effort で送る（#164）
  const chatDefaults = useContext(ChatDefaultsContext);
  const [pickedSettings, setPickedSettings] = useState<ChatDefaults>();
  const firstSettings =
    pickedSettings ?? resolveChatDefaults(chatDefaults.defaults, models);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);
  // 引用を添えたら、続けて質問を書けるよう入力欄に移る（回答の選択範囲からの質問も。#220）。
  // 会話があれば ChatView が移すので、ここでは最初の質問の入力欄（会話が無いと分かってから出る）だけを扱う
  const composingFirst = conversation === null;
  const quoted = wikiQuote !== undefined || draft !== undefined;
  useEffect(() => {
    if (!quoted || !composingFirst) return;
    panel.current
      ?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])")
      ?.focus();
  }, [quoted, composingFirst]);

  const chatId = submittedId ?? (draft === undefined ? branchId : undefined);
  const loadConversation = useCallback(async () => {
    setError(undefined);
    try {
      const result =
        chatId !== undefined
          ? await api.chats.get({ id: chatId })
          : taskId !== undefined && pageId !== undefined
            ? await api.wiki.chat({ taskId, pageId })
            : null;
      setConversation(
        result === null
          ? null
          : {
              chat: result.chat,
              messages: result.messages as ChatUIMessage[],
            },
      );
    } catch {
      setError("サイドチャットを読み込めませんでした。");
    }
  }, [api, chatId, pageId, taskId]);

  useEffect(() => {
    if (chatId !== undefined || pageId !== undefined) void loadConversation();
  }, [chatId, pageId, loadConversation]);

  // 開いている会話を伝える（新しい回答の印を外す。#234）
  const conversationId = conversation?.chat.id;
  useEffect(() => {
    onConversation?.(conversationId);
  }, [conversationId, onConversation]);
  useEffect(() => () => onConversation?.(undefined), [onConversation]);

  const submit = async (text: string, images: ImageAttachment[]) => {
    if (creating) return false;
    requestNotificationPermission();
    setCreating(true);
    setError(undefined);
    try {
      const message = {
        id: crypto.randomUUID(),
        role: "user" as const,
        parts: [
          ...(wiki === undefined || wikiQuote === undefined
            ? []
            : [{ type: "data-quote" as const, data: wikiQuote }]),
          ...imageFileParts(images),
          ...(text === "" ? [] : [{ type: "text" as const, text }]),
        ],
      };
      const result =
        wiki !== undefined
          ? await api.wiki.ask({
              taskId: wiki.taskId,
              pageId: wiki.pageId,
              message,
              ...firstSettings,
            })
          : draft !== undefined && branchId !== undefined
            ? await api.chat.branch({
                parentId: draft.parentId,
                messageId: draft.quote.sourceMessageId,
                branchId,
                message: {
                  ...message,
                  parts: [
                    { type: "data-quote", data: draft.quote },
                    ...message.parts,
                  ],
                },
                ...draft.settings,
                selectBranch: false,
              })
            : undefined;
      if (result === undefined) return false;
      setWikiQuote(undefined);
      setConversation(undefined);
      setSubmittedId(result.chatId);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "質問を送信できませんでした。",
      );
      return false;
    } finally {
      setCreating(false);
    }
    callbacks.onActivity?.();
    return true;
  };

  const title =
    wiki !== undefined
      ? (wiki.title ?? conversation?.chat.title)
      : conversation == null
        ? undefined
        : branchLabel(conversation.chat);

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="サイドチャット"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background outline-none lg:border-l"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
        <div className="min-w-0">
          <h2 className="font-medium text-sm">サイドチャット</h2>
          {title !== undefined && (
            <p className="truncate text-muted-foreground text-xs" title={title}>
              {title}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="サイドチャットを閉じる"
          onClick={onClose}
        >
          <X aria-hidden />
        </Button>
      </header>
      {quoteNotice !== undefined && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2 text-sm"
        >
          <span className="min-w-0 flex-1">
            引用元は、メインで開いている会話にありません。
          </span>
          {quoteNotice.onOpenSource !== undefined && (
            <Button
              size="sm"
              variant="outline"
              onClick={quoteNotice.onOpenSource}
            >
              引用元の会話をメインで開く
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="閉じる"
            onClick={quoteNotice.onDismiss}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        </div>
      )}
      {conversation != null ? (
        <ChatView
          key={conversation.chat.id}
          api={api}
          chat={conversation.chat}
          // 回答から分岐して質問したら（#222）、このサイドチャットで新しい会話を開く
          onSelectBranch={setSubmittedId}
          initialMessages={conversation.messages}
          models={models}
          side
          {...(wiki === undefined
            ? {}
            : {
                pendingQuote: wikiQuote,
                onClearQuote: () => setWikiQuote(undefined),
              })}
          {...callbacks}
        />
      ) : conversation === undefined ? (
        <div className="flex flex-1 flex-col items-start gap-2 p-4 text-sm">
          {error === undefined ? (
            <p role="status">サイドチャットを読み込み中…</p>
          ) : (
            <>
              <p role="alert" className="text-destructive">
                {error}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadConversation()}
              >
                再読み込み
              </Button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto p-4">
            {draft !== undefined && <QuoteBlock text={draft.quote.text} />}
            {wiki !== undefined && wikiQuote !== undefined && (
              <div className="flex items-start gap-1">
                <QuoteBlock text={wikiQuote.text} />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label="引用を外す"
                  onClick={() => setWikiQuote(undefined)}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </div>
            )}
          </div>
          <div className="border-t p-4">
            {error !== undefined && (
              <p role="alert" className="mb-2 text-destructive text-sm">
                {error}
              </p>
            )}
            <Composer
              busy={false}
              pending={creating}
              messageLabel="サイドチャットのメッセージ"
              {...(wiki === undefined
                ? {}
                : {
                    toolbar: (
                      <ModelPicker
                        models={models}
                        model={firstSettings.model}
                        effort={firstSettings.effort}
                        onChange={(next) => {
                          setPickedSettings(next);
                          chatDefaults.choose(next);
                        }}
                      />
                    ),
                  })}
              onSubmit={submit}
            />
          </div>
        </>
      )}
    </aside>
  );
};

/** メインの右に開くカラム（#248）。 */
type WorkspaceColumn =
  | { kind: "branch"; request: BranchRequest }
  | { kind: "wiki"; request: WikiRequest }
  | {
      kind: "page";
      taskId: string;
      pageId: string;
      /** 閉じたときにフォーカスを戻す要素（開いた用語やリンク）。 */
      returnFocus: HTMLElement | null;
    }
  | { kind: "details" };

/** 狭い画面（メインとカラムを 1 列ずつ表示する）か。 */
const isNarrow = () => window.matchMedia("(max-width: 1023.98px)").matches;

/**
 * メインの会話と、その右に開くカラム（サイドチャット・Wiki ノート・セッション詳細。#248）。
 * どのカラムから開いても右端に足し、すでに開いている会話（分岐ごと）・ノートなら、
 * そのカラムまでスクロールして見出しを強調する。カラムは個別に閉じられる。
 */
export const ChatWorkspace = ({
  loading,
  onOpenChat,
  onSideChatsChange,
  task,
  onOpenTask,
  ...props
}: ChatViewProps & {
  /** カラムで開いている会話が変わったとき（新しい回答の印を外すのに使う。#234）。 */
  onSideChatsChange?: ((chatIds: string[]) => void) | undefined;
  loading: boolean;
  /** 別のスレッドの会話を開く（Wiki ページの「元の回答を開く」）。 */
  onOpenChat?: (chatId: string) => void;
  /** 会話が属するタスク（セッション詳細に出す。#245）。 */
  task?: TaskDto | undefined;
  /** タスクの概要を開く（セッション詳細から。#245）。 */
  onOpenTask?: ((taskId: string) => void) | undefined;
}) => {
  const mainChatId = props.chat.id;
  const stack = useColumns<WorkspaceColumn>([`chat:${mainChatId}`]);
  const { columns, open, close, closeWhere, addIdentity } = stack;
  // メインで開いた会話をカラムでも開いていたら、そのカラムは閉じる
  useEffect(() => {
    if (loading) return;
    closeWhere((column) => column.identities.includes(`chat:${mainChatId}`));
  }, [loading, mainChatId, closeWhere]);

  const main = useRef<HTMLElement>(null);
  const focusComposer = () =>
    main.current
      ?.querySelector<HTMLTextAreaElement>("textarea[aria-label='メッセージ']")
      ?.focus();
  const restoreFocus = (returnFocus: HTMLElement | null) =>
    requestAnimationFrame(() => {
      if (returnFocus?.isConnected) {
        returnFocus.focus();
      } else {
        focusComposer();
      }
    });
  const openBranch = (request: BranchRequest) =>
    open([`chat:${request.id}`], { kind: "branch", request });
  const closeColumn = (key: string) => {
    const column = columns.find((item) => item.key === key);
    close(key);
    setQuoteFocus((current) =>
      current?.columnKey === key ? undefined : current,
    );
    if (column?.kind === "details") {
      requestAnimationFrame(() => {
        const toggle = main.current?.ownerDocument.querySelector<HTMLElement>(
          "[data-session-details-toggle]",
        );
        if (toggle?.isConnected) toggle.focus();
        else focusComposer();
      });
    } else {
      restoreFocus(column?.kind === "page" ? column.returnFocus : null);
    }
  };

  // カラムで開いている会話（新しい回答の印を外す。#234）
  const [sideChats, setSideChats] = useState<Record<string, string>>({});
  const onConversationOf = useCallback(
    (key: string) => (chatId: string | undefined) => {
      if (chatId !== undefined) addIdentity(key, `chat:${chatId}`);
      setSideChats((current) => {
        if (current[key] === chatId) return current;
        const { [key]: _, ...rest } = current;
        return chatId === undefined ? rest : { ...rest, [key]: chatId };
      });
    },
    [addIdentity],
  );
  const conversationCallbacks = useRef(
    new Map<string, (chatId: string | undefined) => void>(),
  );
  const conversationCallback = (key: string) => {
    let callback = conversationCallbacks.current.get(key);
    if (callback === undefined) {
      callback = onConversationOf(key);
      conversationCallbacks.current.set(key, callback);
    }
    return callback;
  };
  const openKeys = columns.map((column) => column.key).join(",");
  const sideChatIds = Object.entries(sideChats)
    .filter(([key]) => openKeys.split(",").includes(key))
    .map(([, chatId]) => chatId);
  const sideChatKey = sideChatIds.join(",");
  // 会話の並びが変わったときだけ知らせる
  useEffect(() => {
    onSideChatsChange?.(sideChatKey === "" ? [] : sideChatKey.split(","));
  }, [sideChatKey, onSideChatsChange]);

  /**
   * サイドチャットの引用の引用元を、メインのチャットで示す（#239）。
   * 引用元がメインの会話に無ければ、そのサイドチャットに知らせて引用元の会話を開けるようにする。
   */
  const [quoteFocus, setQuoteFocus] = useState<{
    quote: AnswerQuote;
    chatId: string;
    parentId: string | null;
    nonce: number;
    missed: boolean;
    /** 引用元を示そうとしたサイドチャットのカラム。 */
    columnKey: string;
  }>();
  const locateInMain = (
    quote: AnswerQuote,
    chat: ChatDto,
    columnKey: string,
  ) => {
    // 狭い画面では 1 列ずつ表示するので、メインまで戻ってから示す
    if (isNarrow()) stack.backToMain();
    setQuoteFocus({
      quote,
      chatId: chat.id,
      parentId: chat.parentId,
      nonce: Math.random(),
      missed: false,
      columnKey,
    });
  };
  const quoteFocusRef = useRef(quoteFocus);
  quoteFocusRef.current = quoteFocus;
  const onQuoteFocusResult = (nonce: number, found: boolean) => {
    const current = quoteFocusRef.current;
    if (current?.nonce !== nonce) return;
    if (found) {
      setQuoteFocus(undefined);
      return;
    }
    // 狭い画面（メインに戻った）で見つからなければ、引用元の会話をメインで開く
    if (
      isNarrow() &&
      current.parentId !== null &&
      props.onSelectBranch !== undefined
    ) {
      props.onSelectBranch(current.parentId);
      return;
    }
    setQuoteFocus({ ...current, missed: true });
  };
  /** 用語・引用の Wiki ノートを、右端のカラムで開く（開いていればそのカラムに移る）。 */
  const openWikiPane = useCallback(
    (taskId: string, pageId: string) => {
      const active = document.activeElement;
      open([`page:${pageId}`], {
        kind: "page",
        taskId,
        pageId,
        returnFocus:
          active instanceof HTMLElement && active !== document.body
            ? active
            : null,
      });
    },
    [open],
  );
  const onOpenWikiPage = props.onOpenWikiPage;
  // 会話で Claude が Wiki を編集したかもしれないので、送信・完了のたびに開いているノートを読み直す
  const [wikiRevision, setWikiRevision] = useState(0);
  const onActivity = () => {
    props.onActivity?.();
    setWikiRevision((revision) => revision + 1);
  };

  const detailsKey = columns.find((column) => column.kind === "details")?.key;
  const liveChat =
    props.branches?.find((branch) => branch.id === props.chat.id) ?? props.chat;

  const renderColumn = (column: (typeof columns)[number]) => {
    switch (column.kind) {
      case "details":
        return (
          <SessionDetails
            api={props.api}
            chat={liveChat}
            task={task}
            environment={props.environment}
            onClose={() => closeColumn(column.key)}
            onOpenTask={onOpenTask}
            onOpenWikiPage={openWikiPane}
          />
        );
      case "page":
        return (
          <WikiPane
            api={props.api}
            taskId={column.taskId}
            pageId={column.pageId}
            revision={wikiRevision}
            onClose={() => closeColumn(column.key)}
            onOpenPage={(pageId) => openWikiPane(column.taskId, pageId)}
            onAskSelection={(quote) =>
              open([`wikichat:${column.pageId}`], {
                kind: "wiki",
                request: {
                  kind: "wiki",
                  taskId: column.taskId,
                  pageId: column.pageId,
                  title: quote.sourcePage.title,
                  quote,
                },
              })
            }
            {...(props.onWikiPageCreated === undefined
              ? {}
              : { onWikiPageCreated: props.onWikiPageCreated })}
            onOpenFull={
              onOpenWikiPage === undefined
                ? undefined
                : () => onOpenWikiPage(column.taskId, column.pageId)
            }
            onOpenChat={onOpenChat}
          />
        );
      case "branch":
      case "wiki":
        return (
          <SideChat
            request={column.request}
            api={props.api}
            models={props.models}
            onConversation={conversationCallback(column.key)}
            onLocateQuoteElsewhere={(quote, chat) =>
              locateInMain(quote, chat, column.key)
            }
            quoteNotice={
              quoteFocus?.missed === true && quoteFocus.columnKey === column.key
                ? {
                    onOpenSource:
                      quoteFocus.parentId === null ||
                      props.onSelectBranch === undefined
                        ? undefined
                        : () => {
                            const { parentId } = quoteFocus;
                            setQuoteFocus({ ...quoteFocus, missed: false });
                            if (parentId !== null) {
                              props.onSelectBranch?.(parentId);
                            }
                          },
                    onDismiss: () => setQuoteFocus(undefined),
                  }
                : undefined
            }
            onClose={() => closeColumn(column.key)}
            onActivity={onActivity}
            onOpenWikiPane={openWikiPane}
            {...(props.onOpenWikiPage === undefined
              ? {}
              : { onOpenWikiPage: props.onOpenWikiPage })}
            {...(props.onWikiPageCreated === undefined
              ? {}
              : { onWikiPageCreated: props.onWikiPageCreated })}
          />
        );
    }
  };

  return (
    <ColumnStack
      reveal={stack.reveal}
      highlight={stack.highlight}
      backToMain={{
        target: props.headerSlot,
        onClick: () => {
          stack.backToMain();
          requestAnimationFrame(focusComposer);
        },
      }}
      main={
        <section
          ref={main}
          aria-label="メインのチャット"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {loading ? (
            <p role="status" className="m-auto text-muted-foreground">
              読み込み中…
            </p>
          ) : (
            <ChatView
              key={props.chat.id}
              {...props}
              onActivity={onActivity}
              onAskSelection={(quote, settings) =>
                openBranch({
                  kind: "branch",
                  id: crypto.randomUUID(),
                  draft: { parentId: props.chat.id, quote, settings },
                })
              }
              onOpenSideBranch={(id) => openBranch({ kind: "branch", id })}
              onOpenWikiPane={openWikiPane}
              showRateLimit
              detailsOpen={detailsKey !== undefined}
              onToggleDetails={() =>
                detailsKey === undefined
                  ? open(["details"], { kind: "details" })
                  : closeColumn(detailsKey)
              }
              quoteFocus={quoteFocus}
              onQuoteFocusResult={onQuoteFocusResult}
            />
          )}
        </section>
      }
      columns={columns.map((column) => ({
        key: column.key,
        node: renderColumn(column),
      }))}
    />
  );
};
