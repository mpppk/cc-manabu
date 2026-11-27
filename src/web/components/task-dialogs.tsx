import { type FormEvent, useState } from "react";
import type { EnvironmentDto, TaskDto } from "../../router.ts";
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

/** 環境を新しく作るときの select の値。 */
const NEW_ENVIRONMENT = "";

/** 新しいタスクを作るダイアログ。環境を選ぶか、タスクと同じ名前の環境を新しく作る。 */
const CreateTaskDialog = ({
  open,
  environments,
  initialEnvironmentId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  environments: EnvironmentDto[];
  /** 環境を選んだ状態で開く（環境の行から作るとき）。 */
  initialEnvironmentId?: string | undefined;
  onClose: () => void;
  onSubmit: (name: string, environmentId: string | undefined) => Promise<void>;
}) => {
  const [name, setName] = useState("");
  const [environmentId, setEnvironmentId] = useState(NEW_ENVIRONMENT);
  const [prevOpen, setPrevOpen] = useState(open);
  // 開き直すたびに初期値に戻す
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setName("");
      setEnvironmentId(
        initialEnvironmentId ?? environments[0]?.id ?? NEW_ENVIRONMENT,
      );
    }
  }
  const chosen = environments.find((e) => e.id === environmentId);
  const valid = name.trim() !== "";

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
        <label className="grid gap-2 text-sm">
          <span className="font-medium">環境</span>
          <select
            className="rounded-md border bg-background px-2 py-1.5"
            aria-label="タスクの環境"
            value={environmentId}
            onChange={(event) => setEnvironmentId(event.target.value)}
          >
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
            <option value={NEW_ENVIRONMENT}>
              新しい環境を作る（起動したディレクトリ）
            </option>
          </select>
          <span className="text-muted-foreground text-xs">
            {chosen === undefined
              ? "タスクと同じ名前の環境と Wiki を作ります。ディレクトリはあとで環境の設定から追加できます。"
              : `${chosen.directories.join("、")} で Claude Code が動き、${
                  chosen.wikiName === null
                    ? "Wiki は参照しません。"
                    : `Wiki「${chosen.wikiName}」を参照します。`
                }`}
          </span>
        </label>
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

/** タスクの操作で開くダイアログ。 */
export type TaskDialog =
  | { kind: "create"; environmentId?: string }
  | { kind: "rename" | "delete" | "settings"; taskId: string };

/** タスクの作成・名前変更・設定・削除のダイアログ（サイドバーの行の操作から開く）。 */
export const TaskDialogs = ({
  dialog,
  onClose,
  tasks,
  environments,
  onCreate,
  onRename,
  onDelete,
  onSetAutoTerms,
  onSetEnvironment,
}: {
  dialog: TaskDialog | undefined;
  onClose: () => void;
  tasks: TaskDto[];
  environments: EnvironmentDto[];
  /** environmentId を渡すとその環境に、無ければ同じ名前の環境を新しく作って入れる。 */
  onCreate: (name: string, environmentId?: string) => Promise<void>;
  onRename: (taskId: string, name: string) => Promise<void>;
  onDelete: (taskId: string) => Promise<void>;
  onSetAutoTerms: (taskId: string, enabled: boolean) => Promise<void>;
  /** タスクを別の環境に移す。 */
  onSetEnvironment: (taskId: string, environmentId: string) => Promise<void>;
}) => {
  const current =
    dialog === undefined || dialog.kind === "create"
      ? undefined
      : tasks.find((p) => p.id === dialog.taskId);
  /** 保存中の自動作成の設定（保存が終わるまで表示に使う）。 */
  const [autoTerms, setAutoTerms] = useState<boolean>();
  const currentEnvironment = environments.find(
    (environment) => environment.id === current?.environmentId,
  );
  const [moveError, setMoveError] = useState<string>();

  return (
    <>
      <CreateTaskDialog
        open={dialog?.kind === "create"}
        environments={environments}
        initialEnvironmentId={
          dialog?.kind === "create" ? dialog.environmentId : undefined
        }
        onClose={onClose}
        onSubmit={(name, environmentId) => onCreate(name, environmentId)}
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
              回答から用語ノートを自動で作る
            </span>
            <span className="text-muted-foreground text-xs">
              このタスクのスレッドで回答が終わるたびに、Claude（haiku）を追加で
              1 回呼び出して重要な用語を取り出し、Wiki
              に用語ノートを作ります。その分、サブスクリプションの利用枠（API
              キーの場合は料金）を少し消費します。既存のノートは書き換えません。
            </span>
          </span>
        </label>
        <label className="grid gap-2 text-sm">
          <span className="font-medium">環境</span>
          <select
            className="rounded-md border bg-background px-2 py-1.5"
            aria-label="タスクの環境"
            value={current?.environmentId ?? ""}
            onChange={(event) => {
              if (current === undefined) return;
              setMoveError(undefined);
              onSetEnvironment(current.id, event.target.value).catch(() =>
                setMoveError("環境を変えられませんでした。"),
              );
            }}
          >
            {currentEnvironment === undefined && (
              <option value="">（未設定）</option>
            )}
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>
          {currentEnvironment !== undefined && (
            <span className="text-muted-foreground text-xs">
              {currentEnvironment.wikiName === null
                ? "この環境は Wiki を使っていません。"
                : `Wiki「${currentEnvironment.wikiName}」を参照します。`}
              別の環境に移すと、Wiki
              も移った環境のものになります（作ったスレッドの作業ディレクトリは変わりません）。
            </span>
          )}
          {moveError !== undefined && (
            <span role="alert" className="text-destructive text-xs">
              {moveError}
            </span>
          )}
        </label>
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
        description={`「${current?.name ?? ""}」を削除します。所属しているスレッドは削除されず、未所属に戻ります。Wiki のノートは環境に残ります。`}
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
          const label = chat.title === "" ? "新しいスレッド" : chat.title;
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
