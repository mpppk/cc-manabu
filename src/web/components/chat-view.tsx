import { useChat } from "@ai-sdk/react";
import { ArrowUp, Square } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";
import type { ChatUIMessage } from "../../chat/chat-service.ts";
import type { ChatDto } from "../../router.ts";
import { OrpcChatTransport } from "../lib/chat-transport.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { Markdown } from "./markdown.tsx";
import { Button } from "./ui/button.tsx";

const MessageView = ({
  message,
  streaming,
}: {
  message: ChatUIMessage;
  streaming: boolean;
}) => {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-secondary px-4 py-2">
          {message.parts.map((part, i) =>
            // biome-ignore lint/suspicious/noArrayIndexKey: パーツの順番は変わらない
            part.type === "text" ? <span key={i}>{part.text}</span> : null,
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, i) => {
        switch (part.type) {
          case "text":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: パーツの順番は変わらない
              <Markdown key={i} text={part.text} streaming={streaming} />
            );
          default:
            // ツール・reasoning・承認は #37〜#39 で描画する
            return null;
        }
      })}
    </div>
  );
};

/** 1 つの会話の画面。useChat に oRPC の ChatTransport を渡す。 */
export const ChatView = ({
  api,
  chat,
  initialMessages,
}: {
  api: ApiClient;
  chat: ChatDto;
  initialMessages: ChatUIMessage[];
}) => {
  const transport = useMemo(() => new OrpcChatTransport(api), [api]);
  const { messages, sendMessage, status, stop, error } = useChat<ChatUIMessage>(
    {
      id: chat.id,
      messages: initialMessages,
      transport,
      // リロード時に生成中なら、途中から表示する
      resume: true,
    },
  );
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";

  const submit = () => {
    const text = input.trim();
    if (text === "" || busy) return;
    setInput("");
    void sendMessage({ text });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  };

  const onStop = async () => {
    // サーバ側の生成を止めてから、購読を切る
    await api.chat.stop({ chatId: chat.id });
    await stop();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          {messages.map((message, index) => (
            <MessageView
              key={message.id}
              message={message}
              streaming={busy && index === messages.length - 1}
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
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            className="max-h-48 min-h-11 flex-1 resize-none rounded-xl border bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="メッセージを入力（Enter で送信、Shift+Enter で改行）"
            aria-label="メッセージ"
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <Button size="icon" aria-label="停止" onClick={onStop}>
              <Square />
            </Button>
          ) : (
            <Button
              size="icon"
              aria-label="送信"
              onClick={submit}
              disabled={input.trim() === ""}
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
