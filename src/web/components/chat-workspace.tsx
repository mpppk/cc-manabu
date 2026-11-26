import { X } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  type ChatDefaults,
  resolveChatDefaults,
} from "../../chat/chat-defaults.ts";
import type { ChatUIMessage } from "../../chat/chat-service.ts";
import type { AnswerQuote, WikiPageQuote } from "../../chat/quote.ts";
import type { ChatDto } from "../../router.ts";
import { ChatDefaultsContext } from "../lib/chat-defaults.ts";
import type { SendSettings } from "../lib/chat-transport.ts";
import { branchLabel } from "../lib/groups.ts";
import { type ImageAttachment, imageFileParts } from "../lib/image.ts";
import { requestNotificationPermission } from "../lib/notify.ts";
import {
  MIN_SIDE_PANEL_WIDTH,
  sidePanelWidthProps,
  useElementWidth,
  useReserveMainWidth,
  useSidePanelWidth,
} from "../lib/side-panel-width.ts";
import { cn } from "../lib/utils.ts";
import { ChatView, type ChatViewProps, QuoteBlock } from "./chat-view.tsx";
import { Composer } from "./composer.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { PaneResizer } from "./pane-resizer.tsx";
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
  hidden = false,
  width,
  ...callbacks
}: Pick<
  ChatViewProps,
  | "api"
  | "models"
  | "onActivity"
  | "onOpenWikiPage"
  | "onOpenWikiPane"
  | "onWikiPageCreated"
> & {
  request: BranchRequest | WikiRequest;
  onClose: () => void;
  /**
   * 上に Wiki ページを重ねて開いている間は隠す（#168）。
   * 消さずに隠すので、閉じると入力途中のメッセージごと元に戻る。
   */
  hidden?: boolean;
  /** メインと並べるときの幅（#209）。省略すると既定の幅。 */
  width?: number | undefined;
}) => {
  const widthProps = sidePanelWidthProps(width);
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
  // 引用を添えたら、続けて質問を書けるよう入力欄に移る。会話があれば ChatView が移すので、
  // ここでは最初の質問の入力欄（会話が無いと分かってから出る）だけを扱う
  const composingFirst = conversation === null;
  useEffect(() => {
    if (wikiQuote === undefined || !composingFirst) return;
    panel.current
      ?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])")
      ?.focus();
  }, [wikiQuote, composingFirst]);

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
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col bg-background outline-none lg:flex-none lg:border-l",
        widthProps.className,
        wiki === undefined
          ? "max-lg:fixed max-lg:inset-0 max-lg:z-30"
          : "max-lg:flex-[2] max-lg:border-t",
        hidden && "hidden",
      )}
      style={widthProps.style}
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

/** 右側のペインの左端に置く、幅を変えるハンドル（#209）。狭い画面で単独表示するときは出さない。 */
export const SidePanelResizer = (props: {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}) => (
  <PaneResizer
    side="right"
    label="右側のペインの幅"
    title="ドラッグして右側のペインの幅を変える（←→ キーでも変えられます）"
    className="max-lg:hidden"
    {...props}
  />
);

/**
 * メインの会話と、右側のペイン（サイドチャットか Wiki ページのどちらか 1 つ）。
 * 右側のペインは常に 1 つだけで、新しく開くと前のものと入れ替わる。
 * ただし、サイドチャットを開いているときに用語・引用から開いた Wiki ページは、
 * サイドチャットを隠して上に重ね、閉じると元のサイドチャットに戻る（#168）。
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
  const [side, setSide] = useState<
    BranchRequest | PageRequest | (WikiRequest & { id: string })
  >();
  /**
   * サイドチャットを開いたまま、その上に重ねて開いた Wiki ページ（#168）。
   * 閉じると、隠していたサイドチャットに入力途中のまま戻る。
   */
  const [overlay, setOverlay] = useState<PageRequest>();
  const sideRef = useRef(side);
  sideRef.current = side;
  if (!loading && side?.id === props.chat.id) setSide(undefined);
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
  const openSide = (next: NonNullable<typeof side>) => {
    setOverlay(undefined);
    setSide(next);
  };
  const closeSide = () => {
    const returnFocus = side?.kind === "page" ? side.returnFocus : null;
    setOverlay(undefined);
    setSide(undefined);
    restoreFocus(returnFocus);
  };
  /** 用語・引用の Wiki ページを右側のペインで開く。サイドチャットがあれば、その上に重ねる。 */
  const openWikiPane = useCallback((taskId: string, pageId: string) => {
    const active = document.activeElement;
    const request: PageRequest = {
      kind: "page",
      id: crypto.randomUUID(),
      taskId,
      pageId,
      returnFocus:
        active instanceof HTMLElement && active !== document.body
          ? active
          : null,
    };
    const current = sideRef.current;
    if (current !== undefined && current.kind !== "page") {
      setOverlay(request);
    } else {
      setOverlay(undefined);
      setSide(request);
    }
  }, []);
  const page = overlay ?? (side?.kind === "page" ? side : undefined);
  const closePage = () => {
    if (overlay === undefined) {
      closeSide();
      return;
    }
    setOverlay(undefined);
    restoreFocus(overlay.returnFocus);
  };
  const onOpenWikiPage = props.onOpenWikiPage;
  // 会話で Claude が Wiki を編集したかもしれないので、送信・完了のたびに開いているページを読み直す
  const [wikiRevision, setWikiRevision] = useState(0);
  const onActivity = () => {
    props.onActivity?.();
    setWikiRevision((revision) => revision + 1);
  };

  // 右側のペインの幅（#209）。メインと並べる領域の幅に収める
  const row = useRef<HTMLDivElement>(null);
  const sidePanel = useSidePanelWidth(useElementWidth(row));
  const sideOpen = page !== undefined || side !== undefined;
  useReserveMainWidth(sideOpen ? MIN_SIDE_PANEL_WIDTH : 0);

  return (
    <div ref={row} className="flex min-h-0 min-w-0 flex-1">
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
            onActivity={onActivity}
            onAskSelection={(quote, settings) =>
              openSide({
                kind: "branch",
                id: crypto.randomUUID(),
                draft: { parentId: props.chat.id, quote, settings },
              })
            }
            onOpenSideBranch={(id) => openSide({ kind: "branch", id })}
            onOpenWikiPane={openWikiPane}
            showRateLimit
          />
        )}
      </section>
      {sideOpen && (
        <SidePanelResizer
          width={sidePanel.width}
          min={sidePanel.min}
          max={sidePanel.max}
          onResize={sidePanel.resize}
          onCommit={sidePanel.commit}
        />
      )}
      {page !== undefined && (
        <WikiPane
          key={page.id}
          api={props.api}
          width={sidePanel.width}
          taskId={page.taskId}
          pageId={page.pageId}
          revision={wikiRevision}
          onClose={closePage}
          onOpenPage={(pageId) => openWikiPane(page.taskId, pageId)}
          onAskSelection={(quote) =>
            openSide({
              kind: "wiki",
              id: crypto.randomUUID(),
              taskId: page.taskId,
              pageId: page.pageId,
              title: quote.sourcePage.title,
              quote,
            })
          }
          {...(props.onWikiPageCreated === undefined
            ? {}
            : { onWikiPageCreated: props.onWikiPageCreated })}
          onOpenFull={
            onOpenWikiPage === undefined
              ? undefined
              : () => onOpenWikiPage(page.taskId, page.pageId)
          }
          onOpenChat={onOpenChat}
        />
      )}
      {side !== undefined && side.kind !== "page" && (
        <SideChat
          key={side.id}
          request={side}
          api={props.api}
          models={props.models}
          hidden={overlay !== undefined}
          width={sidePanel.width}
          onClose={closeSide}
          onActivity={onActivity}
          onOpenWikiPane={openWikiPane}
          {...(props.onOpenWikiPage === undefined
            ? {}
            : { onOpenWikiPage: props.onOpenWikiPage })}
          {...(props.onWikiPageCreated === undefined
            ? {}
            : { onWikiPageCreated: props.onWikiPageCreated })}
        />
      )}
    </div>
  );
};
