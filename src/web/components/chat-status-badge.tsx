import { Loader2 } from "lucide-react";
import type { ChatDto } from "../../router.ts";

/**
 * 会話（スレッド）の状態の印。回答中・承認待ち・エラーのときだけ出す。
 * unread なら、回答済みの会話に「新しい回答」の印を出す（#234）。
 */
export const ChatStatusBadge = ({
  status,
  unread = false,
}: {
  status: ChatDto["status"];
  unread?: boolean;
}) => {
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
      return unread ? (
        <span
          className="flex shrink-0 items-center gap-1 text-[10px] text-sky-700 dark:text-sky-400"
          title="開いていない間に回答し終えました"
        >
          <span aria-hidden className="size-2 rounded-full bg-sky-500" />
          新しい回答
        </span>
      ) : null;
  }
};
