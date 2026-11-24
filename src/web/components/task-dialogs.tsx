import { type FormEvent, useState } from "react";
import type { TaskDto, WikiDto } from "../../router.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogFooter } from "./ui/dialog.tsx";

/** タスクの名前を入力するダイアログ（作成・名前変更）。 */
const NameDialog = ({
  open,
  title,
  initial,
  submitLabel,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) => {
  const [name, setName] = useState(initial);
  const [prevOpen, setPrevOpen] = useState(open);
  // 開き直すたびに初期値に戻す
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setName(initial);
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    await onSubmit(name.trim());
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
    >
      <form className="grid gap-4" onSubmit={submit}>
        <input
          className="rounded-md border bg-background px-3 py-2 text-sm"
          aria-label="タスクの名前"
          placeholder="例: 認可基盤"
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" disabled={name.trim() === ""}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
};

/** 新しいタスクを作るダイアログ。Wiki は新しく作るか、既存のものを共有する。 */
const CreateTaskDialog = ({
  open,
  wikis,
  initialWikiId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  wikis: WikiDto[];
  /** 既存の Wiki を選んだ状態で開く（Wiki の行から作るとき）。 */
  initialWikiId?: string | undefined;
  onClose: () => void;
  onSubmit: (name: string, wikiId: string | undefined) => Promise<void>;
}) => {
  const [name, setName] = useState("");
  const [useExisting, setUseExisting] = useState(false);
  const [wikiId, setWikiId] = useState("");
  const [prevOpen, setPrevOpen] = useState(open);
  // 開き直すたびに初期値に戻す
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setName("");
      setUseExisting(initialWikiId !== undefined);
      setWikiId(initialWikiId ?? wikis[0]?.id ?? "");
    }
  }
  const chosen = useExisting ? wikis.find((w) => w.id === wikiId) : undefined;
  const valid = name.trim() !== "" && (!useExisting || chosen !== undefined);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    await onSubmit(name.trim(), chosen?.id);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="新しいタスク"
    >
      <form className="grid gap-4" onSubmit={submit}>
        <input
          className="rounded-md border bg-background px-3 py-2 text-sm"
          aria-label="タスクの名前"
          placeholder="例: 認可基盤"
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <fieldset className="grid gap-2 text-sm">
          <legend className="mb-1 font-medium">Wiki</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="wiki"
              checked={!useExisting}
              onChange={() => setUseExisting(false)}
            />
            新しい Wiki を作る
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="wiki"
              checked={useExisting}
              disabled={wikis.length === 0}
              onChange={() => setUseExisting(true)}
            />
            既存の Wiki を使う
            {wikis.length === 0 && (
              <span className="text-muted-foreground text-xs">
                （まだ Wiki がありません）
              </span>
            )}
          </label>
          {useExisting && (
            <select
              className="ml-6 rounded-md border bg-background px-2 py-1.5"
              aria-label="使う Wiki"
              value={wikiId}
              onChange={(event) => setWikiId(event.target.value)}
            >
              {wikis.map((wiki) => (
                <option key={wiki.id} value={wiki.id}>
                  {wiki.name}（{wiki.taskCount} 件のタスクで使用中）
                </option>
              ))}
            </select>
          )}
          <span className="text-muted-foreground text-xs">
            同じ Wiki
            を使うタスクどうしでは、ページ（用語ページを含む）を共有し、回答の参照資料にも使います。
          </span>
        </fieldset>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" disabled={!valid}>
            作成
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
};

/** Wiki の名前を変える欄（タスクの設定の中）。 */
const WikiNameField = ({
  wiki,
  onRename,
}: {
  wiki: WikiDto;
  onRename: (name: string) => Promise<void>;
}) => {
  const [name, setName] = useState(wiki.name);
  const [prevName, setPrevName] = useState(wiki.name);
  if (wiki.name !== prevName) {
    setPrevName(wiki.name);
    setName(wiki.name);
  }
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "" && name.trim() !== wiki.name) {
          void onRename(name.trim());
        }
      }}
    >
      <input
        className="min-w-0 flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
        aria-label="Wiki の名前"
        maxLength={100}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={name.trim() === "" || name.trim() === wiki.name}
      >
        名前を保存
      </Button>
    </form>
  );
};

/** タスクの操作で開くダイアログ。 */
export type TaskDialog =
  | { kind: "create"; wikiId?: string }
  | { kind: "rename" | "delete" | "settings"; taskId: string };

/** タスクの作成・名前変更・設定・削除のダイアログ（サイドバーの行の操作から開く）。 */
export const TaskDialogs = ({
  dialog,
  onClose,
  tasks,
  wikis,
  onCreate,
  onRename,
  onDelete,
  onSetAutoTerms,
  onRenameWiki,
}: {
  dialog: TaskDialog | undefined;
  onClose: () => void;
  tasks: TaskDto[];
  /** Wiki（複数のタスクで共有できる）。 */
  wikis: WikiDto[];
  /** wikiId を渡すとその Wiki を共有し、無ければ新しい Wiki を作る。 */
  onCreate: (name: string, wikiId?: string) => Promise<void>;
  onRename: (taskId: string, name: string) => Promise<void>;
  onDelete: (taskId: string) => Promise<void>;
  onSetAutoTerms: (taskId: string, enabled: boolean) => Promise<void>;
  onRenameWiki: (wikiId: string, name: string) => Promise<void>;
}) => {
  const current =
    dialog === undefined || dialog.kind === "create"
      ? undefined
      : tasks.find((p) => p.id === dialog.taskId);
  /** 保存中の自動作成の設定（保存が終わるまで表示に使う）。 */
  const [autoTerms, setAutoTerms] = useState<boolean>();
  const currentWiki = wikis.find((wiki) => wiki.id === current?.wikiId);
  /** 対象のタスクと同じ Wiki を使う、ほかのタスク。 */
  const sharing = tasks.filter(
    (p) =>
      current !== undefined &&
      p.wikiId === current.wikiId &&
      p.id !== current.id,
  );

  return (
    <>
      <CreateTaskDialog
        open={dialog?.kind === "create"}
        wikis={wikis}
        initialWikiId={dialog?.kind === "create" ? dialog.wikiId : undefined}
        onClose={onClose}
        onSubmit={(name, wikiId) => onCreate(name, wikiId)}
      />
      <NameDialog
        open={dialog?.kind === "rename"}
        title="タスクの名前を変える"
        initial={current?.name ?? ""}
        submitLabel="保存"
        onClose={onClose}
        onSubmit={async (name) => {
          if (current !== undefined) await onRename(current.id, name);
        }}
      />
      <Dialog
        open={dialog?.kind === "settings"}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="タスクの設定"
        description={current?.name}
      >
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={autoTerms ?? current?.autoTerms ?? false}
            onChange={(event) => {
              if (current === undefined) return;
              const enabled = event.target.checked;
              // 保存を待たずに表示を変え、失敗したら戻す
              setAutoTerms(enabled);
              onSetAutoTerms(current.id, enabled)
                .catch(() => {})
                .finally(() => setAutoTerms(undefined));
            }}
          />
          <span className="flex flex-col gap-1">
            <span className="font-medium text-sm">
              回答から用語ページを自動で作る
            </span>
            <span className="text-muted-foreground text-xs">
              このタスクのスレッドで回答が終わるたびに、Claude（haiku）を追加で
              1 回呼び出して重要な用語を取り出し、Wiki
              に用語ページを作ります。その分、サブスクリプションの利用枠（API
              キーの場合は料金）を少し消費します。既存のページは書き換えません。
            </span>
          </span>
        </label>
        {currentWiki !== undefined && (
          <section className="grid gap-2" aria-label="Wiki">
            <span className="font-medium text-sm">Wiki</span>
            <WikiNameField
              wiki={currentWiki}
              onRename={(name) => onRenameWiki(currentWiki.id, name)}
            />
            <span className="text-muted-foreground text-xs">
              {sharing.length === 0
                ? "この Wiki はこのタスクだけで使っています。"
                : `この Wiki は ${sharing.map((p) => `「${p.name}」`).join("")} と共有しています。名前とページはすべてのタスクに反映されます。`}
            </span>
          </section>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            閉じる
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="タスクを削除しますか？"
        description={`「${current?.name ?? ""}」を削除します。所属しているスレッドは削除されず、未所属に戻ります。${
          sharing.length > 0
            ? `Wiki「${currentWiki?.name ?? ""}」はほかのタスクでも使っているので残ります。`
            : `Wiki「${currentWiki?.name ?? ""}」とそのページも削除されます。`
        }`}
      >
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (current !== undefined) await onDelete(current.id);
              onClose();
            }}
          >
            削除
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
};

/** 未所属のスレッドを選んで、タスクに追加するダイアログ。 */
export const AddThreadsDialog = ({
  open,
  taskName,
  candidates,
  onAdd,
  onClose,
}: {
  open: boolean;
  taskName: string;
  candidates: { id: string; title: string }[];
  onAdd: (chatId: string) => Promise<void>;
  onClose: () => void;
}) => (
  <Dialog
    open={open}
    onOpenChange={(next) => {
      if (!next) onClose();
    }}
    title="既存のスレッドを追加"
    description={`未所属のスレッドを「${taskName}」に追加します。過去のメッセージはそのまま引き継がれます。`}
  >
    {candidates.length === 0 ? (
      <p className="text-muted-foreground text-sm">
        未所属のスレッドはありません。
      </p>
    ) : (
      <ul
        aria-label="未所属のスレッド"
        className="flex max-h-80 flex-col gap-1 overflow-y-auto"
      >
        {candidates.map((chat) => {
          const label = chat.title === "" ? "新しい会話" : chat.title;
          return (
            <li
              key={chat.id}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-accent"
            >
              <span className="truncate text-sm">{label}</span>
              <Button
                size="sm"
                variant="outline"
                aria-label={`「${label}」を追加`}
                onClick={() => void onAdd(chat.id)}
              >
                追加
              </Button>
            </li>
          );
        })}
      </ul>
    )}
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>
        閉じる
      </Button>
    </DialogFooter>
  </Dialog>
);
