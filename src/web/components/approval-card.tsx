import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useState } from "react";
import type { ApprovalData } from "../../chat/approval-broker.ts";
import { taskToolLabel } from "../../task/tool-names.ts";
import { wikiToolLabel } from "../../wiki/tool-names.ts";
import { summarizeToolInput, toolLabel } from "../lib/tool-display.ts";
import { InputView } from "./tool-card.tsx";
import { Button } from "./ui/button.tsx";

/**
 * ツール実行の承認要求（data-approval パーツ）。
 * pending の間は許可・拒否のボタンを出し、答えると allowed / denied の表示に変わる。
 */
export const ApprovalCard = ({
  approval,
  onRespond,
}: {
  approval: ApprovalData;
  onRespond: (
    behavior: "allow" | "deny",
    message: string | undefined,
  ) => Promise<void>;
}) => {
  const [reason, setReason] = useState("");
  const [denying, setDenying] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const respond = async (behavior: "allow" | "deny") => {
    setSending(true);
    setError(undefined);
    try {
      await onRespond(
        behavior,
        behavior === "deny" && reason.trim() !== "" ? reason.trim() : undefined,
      );
    } catch {
      setError("回答を送れませんでした。もう一度お試しください。");
      setSending(false);
    }
  };

  const summary = summarizeToolInput(approval.toolName, approval.input);

  if (approval.status !== "pending") {
    const allowed = approval.status === "allowed";
    return (
      <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
        {allowed ? (
          <ShieldCheck className="size-4 text-emerald-600" />
        ) : (
          <ShieldX className="size-4 text-amber-600" />
        )}
        {toolLabel(approval.toolName)} の実行を
        {allowed ? "許可しました" : "拒否しました"}
        {!allowed &&
          approval.message !== undefined &&
          `（${approval.message}）`}
      </p>
    );
  }

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm"
      aria-label="ツール実行の承認"
    >
      <header className="flex items-center gap-2">
        <ShieldAlert className="size-5 shrink-0 text-amber-600" />
        <div className="min-w-0">
          <p className="font-medium">
            {wikiToolLabel(approval.toolName) ??
              taskToolLabel(approval.toolName) ??
              approval.displayName ??
              approval.toolName}{" "}
            を実行してもよいですか？
          </p>
          {(approval.description ?? summary) !== "" && (
            <p className="truncate text-muted-foreground text-xs">
              {approval.description ?? summary}
            </p>
          )}
        </div>
      </header>
      <InputView toolName={approval.toolName} input={approval.input} />
      {denying && (
        <input
          className="rounded-md border bg-background px-2 py-1.5 text-sm"
          placeholder="拒否する理由（任意。Claude に伝わります）"
          aria-label="拒否する理由"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      )}
      {error !== undefined && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {denying ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={sending}
              onClick={() => setDenying(false)}
            >
              戻る
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={sending}
              onClick={() => void respond("deny")}
            >
              拒否する
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={sending}
              onClick={() => setDenying(true)}
            >
              拒否
            </Button>
            <Button
              size="sm"
              disabled={sending}
              onClick={() => void respond("allow")}
            >
              許可
            </Button>
          </>
        )}
      </div>
    </section>
  );
};
