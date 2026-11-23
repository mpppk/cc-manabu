import {
  Check,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import type { ChatDto } from "../../router.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogFooter } from "./ui/dialog.tsx";

const StatusBadge = ({ status }: { status: ChatDto["status"] }) => {
  switch (status) {
    case "running":
      return (
        <Loader2
          className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          aria-label="生成中"
        />
      );
    case "awaiting_approval":
      return (
        <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
          承認待ち
        </span>
      );
    case "error":
      return (
        <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
          エラー
        </span>
      );
    default:
      return null;
  }
};

const ChatItem = ({
  chat,
  selected,
  onSelect,
  onRename,
  onDelete,
}: {
  chat: ChatDto;
  selected: boolean;
  onSelect: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const label = chat.title === "" ? "新しい会話" : chat.title;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() !== "") {
      await onRename(title.trim());
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <form className="flex items-center gap-1 px-1 py-0.5" onSubmit={submit}>
        <input
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm"
          aria-label="会話の名前"
          value={title}
          // biome-ignore lint/a11y/noAutofocus: 名前の編集を始めた直後に入力できるようにする
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
          }}
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="保存"
        >
          <Check />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="キャンセル"
          onClick={() => setEditing(false)}
        >
          <X />
        </Button>
      </form>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent",
        selected && "bg-sidebar-accent font-medium",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
      >
        <span className="truncate">{label}</span>
        <StatusBadge status={chat.status} />
      </button>
      <div className="hidden shrink-0 group-hover:flex group-focus-within:flex">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`「${label}」の名前を変える`}
          onClick={() => {
            setTitle(chat.title);
            setEditing(true);
          }}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`「${label}」を削除`}
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
};

export const Sidebar = ({
  chats,
  selectedId,
  onNew,
  onSelect,
  onRename,
  onDelete,
}: {
  chats: ChatDto[];
  selectedId: string | undefined;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) => {
  const [deleting, setDeleting] = useState<ChatDto>();

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between p-3">
        <span className="font-semibold">cc-manabu</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="新しい会話"
          onClick={onNew}
        >
          <MessageSquarePlus />
        </Button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2" aria-label="会話一覧">
        {chats.length === 0 ? (
          <p className="px-2 py-4 text-muted-foreground text-sm">
            まだ会話がありません。
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {chats.map((chat) => (
              <li key={chat.id}>
                <ChatItem
                  chat={chat}
                  selected={chat.id === selectedId}
                  onSelect={() => onSelect(chat.id)}
                  onRename={(title) => onRename(chat.id, title)}
                  onDelete={() => setDeleting(chat)}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>
      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title="会話を削除しますか？"
        description={`「${deleting?.title || "新しい会話"}」を削除します。この操作は取り消せません。${deleting?.status === "running" ? "生成中の応答は止まります。" : ""}`}
      >
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleting(undefined)}>
            キャンセル
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (deleting !== undefined) {
                await onDelete(deleting.id);
              }
              setDeleting(undefined);
            }}
          >
            削除
          </Button>
        </DialogFooter>
      </Dialog>
    </aside>
  );
};
