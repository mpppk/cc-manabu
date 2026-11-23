import { CircleAlert, ListOrdered, Pause, Pencil, Play, X } from "lucide-react";
import { useState } from "react";
import type { ChatUIMessage } from "../../chat/chat-service.ts";
import { quotesOf } from "../../chat/quote.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { Button } from "./ui/button.tsx";

export type QueueState = Awaited<ReturnType<ApiClient["queue"]["list"]>>;
export type QueueItem = QueueState["items"][number];

const textOf = (parts: unknown[]): string =>
  (parts as ChatUIMessage["parts"])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");

const extrasOf = (parts: unknown[]): string => {
  const typed = parts as ChatUIMessage["parts"];
  const images = typed.filter((part) => part.type === "file").length;
  const quotes = quotesOf(typed).length;
  return [images > 0 ? `画像 ${images} 枚` : "", quotes > 0 ? "引用あり" : ""]
    .filter((s) => s !== "")
    .join("・");
};

const QueueRow = ({
  item,
  index,
  onUpdate,
  onRemove,
  onRelease,
}: {
  item: QueueItem;
  index: number;
  onUpdate: (text: string) => Promise<void>;
  onRemove: () => Promise<void>;
  onRelease: () => Promise<void>;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const text = textOf(item.parts);
  const extras = extrasOf(item.parts);
  const sending = item.status === "sending";

  return (
    <li className="flex flex-col gap-1 rounded-md border bg-background px-3 py-2">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-muted-foreground text-xs">
          {index + 1}.
        </span>
        {editing ? (
          <textarea
            className="min-h-16 flex-1 resize-y rounded-md border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="予約を編集"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : (
          <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">
            {text === "" ? "（本文なし）" : text}
          </span>
        )}
        {!editing && !sending && (
          <span className="flex shrink-0 gap-1">
            {text !== "" && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="予約を編集"
                onClick={() => {
                  setDraft(text);
                  setEditing(true);
                }}
              >
                <Pencil className="size-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="予約を取り消す"
              onClick={() => void onRemove()}
            >
              <X className="size-3.5" />
            </Button>
          </span>
        )}
      </div>
      {extras !== "" && (
        <span className="pl-5 text-muted-foreground text-xs">{extras}</span>
      )}
      {sending && (
        <span className="pl-5 text-muted-foreground text-xs">送信中…</span>
      )}
      {item.status === "held" && (
        <span className="flex flex-wrap items-center gap-2 pl-5 text-amber-700 text-xs dark:text-amber-400">
          <CircleAlert className="size-3.5" />
          送信済みか確認できません（送信中にサーバが止まりました）。会話を確かめて、送るか取り消してください。
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => void onRelease()}
          >
            送る
          </Button>
        </span>
      )}
      {editing && (
        <span className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
            キャンセル
          </Button>
          <Button
            size="sm"
            disabled={draft.trim() === ""}
            onClick={() => {
              setEditing(false);
              void onUpdate(draft.trim());
            }}
          >
            保存
          </Button>
        </span>
      )}
    </li>
  );
};

/** 予約したメッセージ（#102）。今の回答が終わったあとに、上から順に送る。 */
export const QueuePanel = ({
  state,
  onUpdate,
  onRemove,
  onRelease,
  onResume,
}: {
  state: QueueState;
  onUpdate: (id: string, text: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRelease: (id: string) => Promise<void>;
  onResume: () => Promise<void>;
}) => {
  if (state.items.length === 0) return null;
  const held = state.items.some((item) => item.status === "held");
  return (
    <section
      aria-label="予約したメッセージ"
      className="mx-auto mb-2 flex max-h-64 max-w-3xl flex-col gap-2 overflow-y-auto rounded-md border bg-muted/40 p-2"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {state.paused ? (
          <Pause className="size-4 text-muted-foreground" />
        ) : (
          <ListOrdered className="size-4 text-muted-foreground" />
        )}
        <span className="flex-1">
          {state.paused
            ? `予約 ${state.items.length} 件（一時停止中）`
            : `予約 ${state.items.length} 件。今の回答が終わったあとに順に送ります。`}
        </span>
        {state.paused && (
          <Button
            size="sm"
            className="h-7"
            disabled={held}
            title={held ? "確認できない予約を、送るか取り消してください" : ""}
            onClick={() => void onResume()}
          >
            <Play className="size-3.5" />
            再開
          </Button>
        )}
      </div>
      {state.paused && (
        <p className="text-muted-foreground text-xs">
          停止・エラー・サーバの再起動のため、予約の送信を止めています。内容を確かめてから再開してください。
        </p>
      )}
      <ol className="flex flex-col gap-1.5">
        {state.items.map((item, index) => (
          <QueueRow
            key={item.id}
            item={item}
            index={index}
            onUpdate={(text) => onUpdate(item.id, text)}
            onRemove={() => onRemove(item.id)}
            onRelease={() => onRelease(item.id)}
          />
        ))}
      </ol>
    </section>
  );
};
