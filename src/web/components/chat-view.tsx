import { useChat } from "@ai-sdk/react";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { ArrowUp, Square } from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import type { ChatUIMessage, Effort } from "../../chat/chat-service.ts";
import type { ChatDto } from "../../router.ts";
import { OrpcChatTransport } from "../lib/chat-transport.ts";
import { requestNotificationPermission } from "../lib/notify.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { formatUsage, totalUsage, usageOf } from "../lib/usage.ts";
import { ApprovalCard } from "./approval-card.tsx";
import { Markdown } from "./markdown.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { Reasoning } from "./reasoning.tsx";
import { ToolCard } from "./tool-card.tsx";
import { Button } from "./ui/button.tsx";

const MessageView = ({
  message,
  streaming,
  onRespond,
}: {
  message: ChatUIMessage;
  streaming: boolean;
  onRespond: (
    approvalId: string,
    behavior: "allow" | "deny",
    reason: string | undefined,
  ) => Promise<void>;
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
  const usage = streaming ? undefined : usageOf(message);
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, i) => {
        switch (part.type) {
          case "text":
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: パーツの順番は変わらない
              <Markdown key={i} text={part.text} streaming={streaming} />
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
      {usage !== undefined && (
        <p className="text-muted-foreground text-xs">
          {message.metadata?.model !== undefined &&
            `${message.metadata.model}・`}
          {formatUsage(usage)}
          {message.metadata?.aborted === true && "・中断"}
        </p>
      )}
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

/** 1 つの会話の画面。useChat に oRPC の ChatTransport を渡す。 */
export const ChatView = ({
  api,
  chat,
  initialMessages,
  models,
  onActivity,
}: {
  api: ApiClient;
  chat: ChatDto;
  initialMessages: ChatUIMessage[];
  /** 選べるモデル（system.status から）。 */
  models: ModelInfo[];
  /** 送信・完了など、一覧の表示（タイトル・状態）が変わりうるときに呼ぶ。 */
  onActivity?: () => void;
}) => {
  const [settings, setSettings] = useState<{
    model: string;
    effort: Effort | null;
  }>({ model: chat.model, effort: (chat.effort as Effort | null) ?? null });
  // transport は作り直さず、送信時に最新の設定を読む
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const transport = useMemo(
    () => new OrpcChatTransport(api, () => settingsRef.current),
    [api],
  );
  const { messages, sendMessage, status, stop, error } = useChat<ChatUIMessage>(
    {
      id: chat.id,
      messages: initialMessages,
      transport,
      // リロード時に生成中なら、途中から表示する
      resume: true,
      onFinish: () => onActivity?.(),
    },
  );
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";

  const submit = () => {
    const text = input.trim();
    if (text === "" || busy) return;
    setInput("");
    requestNotificationPermission();
    void sendMessage({ text }).then(() => onActivity?.());
    // タイトルと状態（生成中）をすぐ一覧に反映する
    setTimeout(() => onActivity?.(), 300);
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
