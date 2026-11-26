import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatUIMessage } from "../../chat/chat-service.ts";
import type { QuoteData } from "../../chat/quote.ts";
import type { ChatDto } from "../../router.ts";
import type { SendSettings } from "../lib/chat-transport.ts";
import { branchLabel } from "../lib/groups.ts";
import { type ImageAttachment, imageFileParts } from "../lib/image.ts";
import { requestNotificationPermission } from "../lib/notify.ts";
import { cn } from "../lib/utils.ts";
import { ChatView, type ChatViewProps, QuoteBlock } from "./chat-view.tsx";
import { Composer } from "./composer.tsx";
import { Button } from "./ui/button.tsx";
import { WikiPane } from "./wiki-pane.tsx";

type SideDraft = {
  parentId: string;
  quote: QuoteData;
  settings: SendSettings;
};
type BranchRequest = { kind: "branch"; id: string; draft?: SideDraft };
type WikiRequest = {
  kind: "wiki";
  taskId: string;
  pageId: string;
  title?: string;
};
type SideConversation = { chat: ChatDto; messages: ChatUIMessage[] };
/** 回答中の用語・引用から、会話の右側に開く Wiki ページ。 */
type PageRequest = {
  kind: "page";
  id: string;
  taskId: string;
  pageId: string;
  /** 閉じたときにフォーカスを戻す要素（開いた用語やリンク）。 */
  returnFocus: HTMLElement | null;
};

/** 分岐した会話、または Wiki ページにひも付く会話をサイドで開く。 */
export const SideChat = ({
  request,
  onClose,
  api,
  models,
  ...callbacks
}: Pick<
  ChatViewProps,
  "api" | "models" | "onActivity" | "onOpenWikiPage" | "onWikiPageCreated"
> & {
  request: BranchRequest | WikiRequest;
  onClose: () => void;
}) => {
  const wiki = request.kind === "wiki" ? request : undefined;
  const taskId = wiki?.taskId;
  const pageId = wiki?.pageId;
  const draft = request.kind === "branch" ? request.draft : undefined;
  const branchId = request.kind === "branch" ? request.id : undefined;
  const [submittedId, setSubmittedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [conversation, setConversation] = useState<
    SideConversation | null | undefined
  >(draft === undefined ? undefined : null);
  const [error, setError] = useState<string>();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);

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
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col bg-background outline-none lg:w-[42%] lg:min-w-80 lg:max-w-xl lg:flex-none lg:border-l",
        wiki === undefined
          ? "max-lg:fixed max-lg:inset-0 max-lg:z-30"
          : "max-lg:flex-[2] max-lg:border-t",
      )}
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
      {conversation != null ? (
        <ChatView
          api={api}
          chat={conversation.chat}
          initialMessages={conversation.messages}
          models={models}
          side
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
              onSubmit={submit}
            />
          </div>
        </>
      )}
    </aside>
  );
};

/**
 * メインの会話と、右側のペイン（サイドチャットか Wiki ページのどちらか 1 つ）。
 * 右側のペインは常に 1 つだけで、新しく開くと前のものと入れ替わる。
 */
export const ChatWorkspace = ({
  loading,
  onOpenChat,
  ...props
}: ChatViewProps & {
  loading: boolean;
  /** 別のスレッドの会話を開く（Wiki ページの「元の回答を開く」）。 */
  onOpenChat?: (chatId: string) => void;
}) => {
  const [side, setSide] = useState<BranchRequest | PageRequest>();
  if (!loading && side?.id === props.chat.id) setSide(undefined);
  const main = useRef<HTMLElement>(null);
  const focusComposer = () =>
    main.current
      ?.querySelector<HTMLTextAreaElement>("textarea[aria-label='メッセージ']")
      ?.focus();
  const closeSide = () => {
    const returnFocus = side?.kind === "page" ? side.returnFocus : null;
    setSide(undefined);
    requestAnimationFrame(() => {
      if (returnFocus?.isConnected) {
        returnFocus.focus();
      } else {
        focusComposer();
      }
    });
  };
  const openWikiPane = useCallback((taskId: string, pageId: string) => {
    const active = document.activeElement;
    setSide({
      kind: "page",
      id: crypto.randomUUID(),
      taskId,
      pageId,
      returnFocus:
        active instanceof HTMLElement && active !== document.body
          ? active
          : null,
    });
  }, []);
  const onOpenWikiPage = props.onOpenWikiPage;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section
        ref={main}
        aria-label="メインのチャット"
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          side !== undefined && "max-lg:hidden",
        )}
      >
        {loading ? (
          <p role="status" className="m-auto text-muted-foreground">
            読み込み中…
          </p>
        ) : (
          <ChatView
            key={props.chat.id}
            {...props}
            onAskSelection={(quote, settings) =>
              setSide({
                kind: "branch",
                id: crypto.randomUUID(),
                draft: { parentId: props.chat.id, quote, settings },
              })
            }
            onOpenSideBranch={(id) => setSide({ kind: "branch", id })}
            onOpenWikiPane={openWikiPane}
          />
        )}
      </section>
      {side?.kind === "page" ? (
        <WikiPane
          key={side.id}
          api={props.api}
          pageId={side.pageId}
          onClose={closeSide}
          onOpenFull={
            onOpenWikiPage === undefined
              ? undefined
              : () => onOpenWikiPage(side.taskId, side.pageId)
          }
          onOpenChat={onOpenChat}
        />
      ) : side !== undefined ? (
        <SideChat
          key={side.id}
          request={side}
          api={props.api}
          models={props.models}
          onClose={closeSide}
          {...(props.onActivity === undefined
            ? {}
            : { onActivity: props.onActivity })}
          {...(props.onOpenWikiPage === undefined
            ? {}
            : { onOpenWikiPage: props.onOpenWikiPage })}
          {...(props.onWikiPageCreated === undefined
            ? {}
            : { onWikiPageCreated: props.onWikiPageCreated })}
        />
      ) : null}
    </div>
  );
};
