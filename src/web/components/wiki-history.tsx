import { Bookmark, History, Redo2, RotateCcw, Undo2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type {
  WikiBatchDto,
  WikiCheckpointDto,
  WikiVersionDto,
} from "../../router.ts";
import { lineDiff } from "../lib/diff.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogFooter } from "./ui/dialog.tsx";

/**
 * Wiki の変更履歴・元に戻す / やり直す・チェックポイント（#166）。
 */

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message !== "" ? error.message : fallback;

const formatTime = (value: Date | string) =>
  new Date(value).toLocaleString("ja-JP");

const TOOL_LABELS: Record<string, string> = {
  create_page: "作成",
  update_page: "書き換え",
  edit_page: "編集",
};

/** 版の出どころと操作を、一覧に出す文言にする。 */
export const versionLabel = (
  version: Pick<WikiVersionDto, "op" | "actor" | "tool" | "deleted">,
): string => {
  switch (version.op) {
    case "baseline":
      return "履歴の記録を始めたときの内容";
    case "undo":
      return "元に戻す";
    case "redo":
      return "やり直す";
    case "restore":
      return "復元";
  }
  const action = version.deleted ? "削除" : undefined;
  switch (version.actor) {
    case "claude":
      return `Claude（${action ?? TOOL_LABELS[version.tool ?? ""] ?? "編集"}）`;
    case "claude_desktop":
      return `Claude Desktop（${action ?? TOOL_LABELS[version.tool ?? ""] ?? "編集"}）`;
    case "auto":
      return "回答から自動作成";
    case "selection":
      return "選択範囲から作成";
    case "system":
      return "履歴の記録を始めたときの内容";
    case "user":
      return action === undefined ? "あなたの編集" : "あなたが削除";
  }
};

/** まとまりの説明（「元に戻す」ボタンの説明に使う）。 */
const batchLabel = (batch: WikiBatchDto): string => {
  const titles = batch.pages
    .slice(0, 3)
    .map((page) => `「${page.title}」`)
    .join("");
  const more =
    batch.pages.length > 3 ? ` ほか ${batch.pages.length - 3} 件` : "";
  const who =
    batch.op === "restore"
      ? "復元"
      : batch.actor === "claude"
        ? "Claude の変更"
        : batch.actor === "claude_desktop"
          ? "Claude Desktop の変更"
          : batch.actor === "auto"
            ? "自動作成"
            : batch.actor === "selection"
              ? "選択範囲からの作成"
              : "変更";
  return `${titles}${more}の${who}`;
};

/** Wiki 画面の「元に戻す」「やり直す」「チェックポイント」。 */
export const WikiHistoryToolbar = ({
  api,
  taskId,
  revision,
  onChanged,
}: {
  api: ApiClient;
  taskId: string;
  /** Wiki が変わるたびに変わる値（元に戻せる変更を読み直す）。 */
  revision: number;
  /** 元に戻す・やり直す・チェックポイントへ戻したあとに呼ぶ（ページを読み直す）。 */
  onChanged: () => void;
}) => {
  const [state, setState] = useState<{
    undo: WikiBatchDto | null;
    redo: WikiBatchDto | null;
  }>({ undo: null, redo: null });
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);

  const load = useCallback(() => {
    api.wiki.undoState({ taskId }).then(setState, () => {});
  }, [api, taskId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision が変わったら読み直す
  useEffect(() => load(), [load, revision]);
  useEffect(() => {
    if (notice === undefined) return;
    const timer = setTimeout(() => setNotice(undefined), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const run = async (redo: boolean) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const batch = await api.wiki.undo({ taskId, redo });
      setNotice(
        `${batchLabel(batch)}を${redo ? "やり直しました" : "元に戻しました"}。`,
      );
      onChanged();
    } catch (failure) {
      setError(
        errorMessage(
          failure,
          redo ? "やり直せませんでした。" : "元に戻せませんでした。",
        ),
      );
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <div className="relative flex items-center">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || state.undo === null}
          title={
            state.undo === null
              ? "元に戻す変更はありません"
              : `${batchLabel(state.undo)}を元に戻す`
          }
          onClick={() => void run(false)}
        >
          <Undo2 className="size-3.5" />
          <span className="max-md:sr-only">元に戻す</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || state.redo === null}
          title={
            state.redo === null
              ? "やり直す変更はありません"
              : `${batchLabel(state.redo)}をやり直す`
          }
          onClick={() => void run(true)}
        >
          <Redo2 className="size-3.5" />
          <span className="max-md:sr-only">やり直す</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCheckpointsOpen(true)}
        >
          <Bookmark className="size-3.5" />
          <span className="max-md:sr-only">チェックポイント</span>
        </Button>
      </div>
      {error !== undefined && (
        <p
          role="alert"
          className="absolute top-full right-0 z-20 mt-2 w-max max-w-md rounded-md border bg-background px-2 py-1 text-destructive text-xs shadow-sm"
        >
          {error}
        </p>
      )}
      {notice !== undefined && (
        <p
          role="status"
          className="absolute top-full right-0 z-20 mt-2 w-max max-w-md rounded-md border bg-background px-2 py-1 text-muted-foreground text-xs shadow-sm"
        >
          {notice}
        </p>
      )}
      <CheckpointDialog
        open={checkpointsOpen}
        api={api}
        taskId={taskId}
        onClose={() => setCheckpointsOpen(false)}
        onRestored={() => {
          onChanged();
          load();
        }}
      />
    </div>
  );
};

/** チェックポイントの一覧・作成・戻す。 */
const CheckpointDialog = ({
  open,
  api,
  taskId,
  onClose,
  onRestored,
}: {
  open: boolean;
  api: ApiClient;
  taskId: string;
  onClose: () => void;
  onRestored: () => void;
}) => {
  const [checkpoints, setCheckpoints] = useState<WikiCheckpointDto[]>();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.wiki
      .checkpoints({ taskId })
      .then(setCheckpoints, () =>
        setError("チェックポイントを読み込めませんでした。"),
      );
  }, [api, taskId]);
  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setNotice(undefined);
    load();
  }, [open, load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "" || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.wiki.createCheckpoint({ taskId, name: name.trim() });
      setName("");
      setNotice("チェックポイントを作りました。");
      load();
    } catch (failure) {
      setError(errorMessage(failure, "チェックポイントを作れませんでした。"));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (checkpoint: WikiCheckpointDto) => {
    setBusy(true);
    setError(undefined);
    try {
      const { changed } = await api.wiki.restoreCheckpoint({
        taskId,
        id: checkpoint.id,
      });
      setNotice(
        changed === 0
          ? `「${checkpoint.name}」の時点と同じ内容です。`
          : `「${checkpoint.name}」の時点に戻しました（${changed} 件のノート）。「元に戻す」で取り消せます。`,
      );
      onRestored();
    } catch (failure) {
      setError(errorMessage(failure, "チェックポイントに戻せませんでした。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="チェックポイント"
      description="Wiki 全体の状態を残しておき、あとでその時点に戻せます。Claude が Wiki を変更する回答の前にも、自動で作ります。"
    >
      <form className="flex items-center gap-2" onSubmit={create}>
        <input
          className="min-w-0 flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
          aria-label="チェックポイントの名前"
          placeholder="例: 整理する前"
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy || name.trim() === ""}>
          今の状態を残す
        </Button>
      </form>
      {error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {notice !== undefined && (
        <p role="status" className="text-muted-foreground text-sm">
          {notice}
        </p>
      )}
      <ul
        aria-label="チェックポイントの一覧"
        className="flex max-h-72 flex-col gap-1 overflow-y-auto"
      >
        {checkpoints?.length === 0 && (
          <li className="text-muted-foreground text-sm">
            まだチェックポイントはありません。
          </li>
        )}
        {checkpoints?.map((checkpoint) => (
          <li
            key={checkpoint.id}
            className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate">
                {checkpoint.name}
                {checkpoint.auto && (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                    自動
                  </span>
                )}
              </span>
              <span className="text-muted-foreground text-xs">
                {formatTime(checkpoint.createdAt)}
              </span>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              aria-label={`「${checkpoint.name}」の時点に戻す`}
              onClick={() => void restore(checkpoint)}
            >
              <RotateCcw className="size-3.5" />
              この時点に戻す
            </Button>
          </li>
        ))}
      </ul>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          閉じる
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

type VersionContent = WikiVersionDto & { aliases: string[]; body: string };

/** 版の中身を比べる形にする（タイトル・別名・本文）。 */
const comparable = (version: VersionContent | undefined): string =>
  version === undefined
    ? ""
    : [
        `# ${version.title}`,
        ...(version.aliases.length === 0
          ? []
          : [`別名: ${version.aliases.join(", ")}`]),
        "",
        version.body,
      ].join("\n");

/** ノートの変更履歴。版の一覧・2 つの版の差分・版への復元。 */
export const WikiHistoryPanel = ({
  api,
  taskId,
  pageId,
  revision,
  onRestored,
  onOpenAnswer,
}: {
  api: ApiClient;
  taskId: string;
  pageId: string;
  revision: number;
  onRestored: () => void;
  /** Claude の版の元の会話・回答を開く。 */
  onOpenAnswer?: ((chatId: string, messageId?: string) => void) | undefined;
}) => {
  const [versions, setVersions] = useState<WikiVersionDto[]>();
  const [from, setFrom] = useState<number>();
  const [to, setTo] = useState<number>();
  const [contents, setContents] = useState<Map<number, VersionContent>>(
    () => new Map(),
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision が変わったら読み直す
  useEffect(() => {
    let active = true;
    api.wiki.history({ taskId, pageId }).then(
      (loaded) => {
        if (!active) return;
        setVersions(loaded);
        // 既定は、最新の版と 1 つ前の版を比べる
        setTo(loaded[0]?.seq);
        setFrom(loaded[1]?.seq);
      },
      () => active && setError("履歴を読み込めませんでした。"),
    );
    return () => {
      active = false;
    };
  }, [api, taskId, pageId, revision]);

  useEffect(() => {
    for (const seq of [from, to]) {
      if (seq === undefined || contents.has(seq)) continue;
      api.wiki.version({ taskId, seq }).then(
        (content) =>
          setContents((current) => new Map(current).set(seq, content)),
        () => {},
      );
    }
  }, [api, taskId, from, to, contents]);

  const restore = async (version: WikiVersionDto) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.wiki.restoreVersion({ taskId, seq: version.seq });
      onRestored();
    } catch (failure) {
      setError(errorMessage(failure, "復元できませんでした。"));
    } finally {
      setBusy(false);
    }
  };

  const before = from === undefined ? undefined : contents.get(from);
  const after = to === undefined ? undefined : contents.get(to);
  const diff =
    to === undefined || after === undefined
      ? undefined
      : lineDiff(
          before?.deleted === false || before === undefined
            ? comparable(before)
            : "",
          after.deleted ? "" : comparable(after),
        );
  const option = (version: WikiVersionDto) => (
    <option key={version.seq} value={version.seq}>
      {formatTime(version.createdAt)}・{versionLabel(version)}
    </option>
  );

  return (
    <section
      aria-label="変更履歴"
      className="flex flex-col gap-3 rounded-md border p-3 text-sm"
    >
      <h3 className="flex items-center gap-1.5 font-semibold">
        <History className="size-4" aria-hidden />
        変更履歴
      </h3>
      {error !== undefined && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {versions === undefined ? (
        <p className="text-muted-foreground">読み込み中…</p>
      ) : versions.length === 0 ? (
        <p className="text-muted-foreground">まだ履歴はありません。</p>
      ) : (
        <>
          <ol aria-label="版の一覧" className="flex flex-col gap-1">
            {versions.map((version, index) => (
              <li
                key={version.seq}
                data-version={version.seq}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5"
              >
                <span className="flex min-w-0 flex-col">
                  <span>
                    {index === versions.length - 1 &&
                    version.op === "change" &&
                    version.actor === "user" &&
                    !version.deleted
                      ? "あなたが作成"
                      : versionLabel(version)}
                    {version.deleted && version.op !== "change" && "（削除）"}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {formatTime(version.createdAt)}・{version.title}
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  {version.chatId !== null && onOpenAnswer !== undefined && (
                    <button
                      type="button"
                      className="text-primary text-xs underline"
                      onClick={() => {
                        if (version.chatId !== null) {
                          onOpenAnswer(
                            version.chatId,
                            version.messageId ?? undefined,
                          );
                        }
                      }}
                    >
                      元の回答を開く
                    </button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`${formatTime(version.createdAt)} の版に復元`}
                    onClick={() => void restore(version)}
                  >
                    {version.deleted ? "削除前に復元" : "この版に復元"}
                  </Button>
                </span>
              </li>
            ))}
          </ol>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">差分</span>
              <select
                className="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                aria-label="比べる前の版"
                value={from ?? ""}
                onChange={(event) =>
                  setFrom(
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value),
                  )
                }
              >
                <option value="">（なし）</option>
                {versions.map(option)}
              </select>
              <span aria-hidden>→</span>
              <select
                className="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                aria-label="比べる後の版"
                value={to ?? ""}
                onChange={(event) => setTo(Number(event.target.value))}
              >
                {versions.map(option)}
              </select>
            </div>
            {diff === undefined ? (
              <p className="text-muted-foreground text-xs">読み込み中…</p>
            ) : (
              <pre
                data-testid="wiki-diff"
                className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-2 font-mono text-xs"
              >
                {diff.map((line, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: 差分の行は位置で決まる
                    key={index}
                    data-diff={line.type}
                    className={cn(
                      line.type === "add" &&
                        "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
                      line.type === "remove" &&
                        "bg-destructive/15 text-destructive line-through",
                    )}
                  >
                    {line.type === "add"
                      ? "+ "
                      : line.type === "remove"
                        ? "- "
                        : "  "}
                    {line.text}
                  </div>
                ))}
              </pre>
            )}
          </div>
        </>
      )}
    </section>
  );
};
