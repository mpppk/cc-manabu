import { MonitorUp, RefreshCw, X } from "lucide-react";
import { Button } from "./ui/button.tsx";

/**
 * 会話のヘッダーの「Claude Desktopで開く」（#244）。表示中の会話のセッションを Claude Desktop の
 * Code タブで開く。開けないとき（セッションが無い・生成中・承認待ち）は押しても開かず、理由を出す。
 */
export const OpenInDesktopButton = ({
  blocker,
  opening,
  onOpen,
  onBlocked,
}: {
  /** 開けない理由。開けるなら undefined。 */
  blocker: string | undefined;
  opening: boolean;
  onOpen: () => void;
  /** 開けないときに押した（理由を知らせる）。 */
  onBlocked: (reason: string) => void;
}) => (
  <Button
    type="button"
    variant="outline"
    size="sm"
    className="gap-1.5 px-2"
    aria-disabled={blocker !== undefined || opening}
    title={
      blocker ??
      "表示中の会話を、同じ PC の Claude Desktop（Code タブ）で開きます"
    }
    onClick={() => {
      if (opening) return;
      if (blocker !== undefined) onBlocked(blocker);
      else onOpen();
    }}
  >
    <MonitorUp className="size-4 text-muted-foreground" />
    <span className="hidden sm:inline">
      {opening ? "開いています…" : "Claude Desktopで開く"}
    </span>
    <span className="sr-only sm:hidden">Claude Desktopで開く</span>
  </Button>
);

/** Claude Desktop で開いた結果・開けなかった理由（#244）。 */
export const DesktopNotice = ({
  notice,
  onClose,
}: {
  notice: { kind: "info" | "error"; text: string };
  onClose: () => void;
}) => (
  <div
    role={notice.kind === "error" ? "alert" : "status"}
    className={
      notice.kind === "error"
        ? "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive text-sm"
        : "flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
    }
  >
    <MonitorUp aria-hidden className="mt-0.5 size-4 shrink-0" />
    <span className="min-w-0 flex-1 break-words">{notice.text}</span>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6 shrink-0"
      aria-label="閉じる"
      onClick={onClose}
    >
      <X className="size-3.5" />
    </Button>
  </div>
);

/**
 * Claude Code 側に、Monet に取り込んでいない質問があることの案内（#244）。
 * 同じセッションを Claude Desktop や CLI で続けると、その発言は Monet の画面には出ない。
 */
export const UnimportedNotice = ({
  prompts,
  checking,
  onRecheck,
}: {
  prompts: number;
  checking: boolean;
  onRecheck: () => void;
}) => (
  <div
    role="status"
    aria-label="未取り込みのメッセージ"
    className="flex flex-wrap items-center gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm"
  >
    <span className="min-w-0 flex-1">
      Claude Code 側に未取り込みのメッセージがあります（質問 {prompts}{" "}
      件）。Claude Desktop や CLI で同じ会話に追加した発言は、Monet
      の画面には表示されません。
    </span>
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 gap-1 px-2 text-xs"
      disabled={checking}
      onClick={onRecheck}
    >
      <RefreshCw
        aria-hidden
        className={checking ? "size-3.5 animate-spin" : "size-3.5"}
      />
      再確認
    </Button>
  </div>
);
