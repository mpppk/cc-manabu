import { Redo2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatUIMessage } from "../../chat/chat-service.ts";
import { WIKI_TOOL_NAMES } from "../../wiki/tool-names.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { Button } from "./ui/button.tsx";

const WRITE_TOOLS = new Set<string>([
  WIKI_TOOL_NAMES.createPage,
  WIKI_TOOL_NAMES.updatePage,
  WIKI_TOOL_NAMES.editPage,
]);

/** 回答の中で Claude が Wiki を書き換えるツールを使ったか（結果が返ったもの）。 */
export const changedWiki = (message: ChatUIMessage): boolean =>
  message.parts.some(
    (part) =>
      part.type === "dynamic-tool" &&
      WRITE_TOOLS.has(part.toolName) &&
      part.state === "output-available",
  );

type Status = { pages: number; undone: boolean } | null;

/**
 * 回答の中で Claude が Wiki に加えた変更を、まとめて元に戻す・やり直す（#166）。
 * 後から別の変更が入っていたら上書きせず、理由を出す。
 */
export const AnswerWikiUndo = ({
  api,
  messageId,
  onChanged,
}: {
  api: ApiClient;
  messageId: string;
  /** 元に戻した・やり直したあとに呼ぶ（用語やペインを読み直す）。 */
  onChanged?: (() => void) | undefined;
}) => {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (retry: boolean) =>
      api.wiki.answerChanges({ messageId }).then(
        (changes) => {
          if (!active) return;
          // 回答の id は回答の保存のあとに付くので、まだ無ければ少し待って取り直す
          if (changes === null && retry) {
            timer = setTimeout(() => void load(false), 1500);
            return;
          }
          setStatus(
            changes === null
              ? null
              : { pages: changes.batch.pages.length, undone: changes.undone },
          );
        },
        () => active && setStatus(null),
      );
    void load(true);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, messageId]);

  if (status == null) return null;
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.wiki.undoAnswer({ messageId, redo: status.undone });
      setStatus({ ...status, undone: !status.undone });
      onChanged?.();
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message !== ""
          ? failure.message
          : "Wiki の変更を元に戻せませんでした。",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-muted-foreground text-xs"
        disabled={busy}
        onClick={() => void run()}
      >
        {status.undone ? (
          <Redo2 className="size-3.5" />
        ) : (
          <Undo2 className="size-3.5" />
        )}
        {status.undone
          ? "この回答での Wiki の変更をやり直す"
          : "この回答での Wiki の変更を元に戻す"}
      </Button>
      {error !== undefined && (
        <span role="alert" className="text-destructive text-xs">
          {error}
        </span>
      )}
    </span>
  );
};
