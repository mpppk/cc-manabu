import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatUIMessage } from "../../chat/chat-service.ts";
import type { QuoteData } from "../../chat/quote.ts";
import type { ChatDto } from "../../router.ts";
import type { SendSettings } from "../lib/chat-transport.ts";
import { type ImageAttachment, imageFileParts } from "../lib/image.ts";
import { requestNotificationPermission } from "../lib/notify.ts";
import { cn } from "../lib/utils.ts";
import { ChatView, type ChatViewProps, QuoteBlock } from "./chat-view.tsx";
import { Composer } from "./composer.tsx";
import { Button } from "./ui/button.tsx";

type SideRequest = {
  id: string;
  parentId: string;
  quote: QuoteData;
  settings: SendSettings;
};
type SideBranch = { chat: ChatDto; messages: ChatUIMessage[] };

/** 選択した回答を起点に、独立した分岐を作って続ける。 */
const SideChat = ({
  request,
  onClose,
  api,
  models,
  ...callbacks
}: Pick<
  ChatViewProps,
  "api" | "models" | "onActivity" | "onOpenWikiPage" | "onCreateWikiPage"
> & {
  request: SideRequest;
  onClose: () => void;
}) => {
  const [created, setCreated] = useState(false);
  const [creating, setCreating] = useState(false);
  const [branch, setBranch] = useState<SideBranch>();
  const [error, setError] = useState<string>();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);

  const loadBranch = async () => {
    setError(undefined);
    try {
      const { chat, messages } = await api.chats.get({ id: request.id });
      setBranch({ chat, messages: messages as ChatUIMessage[] });
    } catch {
      setError("サイドチャットを読み込めませんでした。");
    }
  };

  const submit = async (text: string, images: ImageAttachment[]) => {
    if (creating) return false;
    requestNotificationPermission();
    setCreating(true);
    setError(undefined);
    try {
      await api.chat.branch({
        parentId: request.parentId,
        messageId: request.quote.sourceMessageId,
        branchId: request.id,
        message: {
          id: crypto.randomUUID(),
          role: "user",
          parts: [
            { type: "data-quote", data: request.quote },
            ...imageFileParts(images),
            ...(text === "" ? [] : [{ type: "text" as const, text }]),
          ],
        },
        ...request.settings,
        selectBranch: false,
      });
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "分岐を作れませんでした。",
      );
      return false;
    } finally {
      setCreating(false);
    }
    setCreated(true);
    callbacks.onActivity?.();
    await loadBranch();
    return true;
  };

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="サイドチャット"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background outline-none max-lg:fixed max-lg:inset-0 max-lg:z-30 lg:w-[42%] lg:min-w-80 lg:max-w-xl lg:flex-none lg:border-l"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
        <h2 className="font-medium text-sm">サイドチャット</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="サイドチャットを閉じる"
          onClick={onClose}
        >
          <X aria-hidden />
        </Button>
      </header>
      {branch !== undefined ? (
        <ChatView
          api={api}
          chat={branch.chat}
          initialMessages={branch.messages}
          models={models}
          side
          {...callbacks}
        />
      ) : created ? (
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
                onClick={() => void loadBranch()}
              >
                再読み込み
              </Button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto p-4">
            <QuoteBlock text={request.quote.text} />
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

export const ChatWorkspace = ({
  loading,
  ...props
}: ChatViewProps & { loading: boolean }) => {
  const [side, setSide] = useState<SideRequest>();
  if (!loading && side?.id === props.chat.id) setSide(undefined);
  const main = useRef<HTMLElement>(null);
  const closeSide = () => {
    setSide(undefined);
    requestAnimationFrame(() =>
      main.current
        ?.querySelector<HTMLTextAreaElement>(
          "textarea[aria-label='メッセージ']",
        )
        ?.focus(),
    );
  };

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
                id: crypto.randomUUID(),
                parentId: props.chat.id,
                quote,
                settings,
              })
            }
          />
        )}
      </section>
      {side !== undefined && (
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
          {...(props.onCreateWikiPage === undefined
            ? {}
            : { onCreateWikiPage: props.onCreateWikiPage })}
        />
      )}
    </div>
  );
};
