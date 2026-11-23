import { FolderPlus, Pencil, Settings, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { ProjectDto } from "../../router.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogFooter } from "./ui/dialog.tsx";

/** 未所属の会話を表す select の値。 */
const UNASSIGNED = "";

/** プロジェクトの名前を入力するダイアログ（作成・名前変更）。 */
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
          aria-label="プロジェクトの名前"
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

/** サイドバー上部のプロジェクト選択（作成・名前変更・削除）。 */
export const ProjectSwitcher = ({
  projects,
  projectId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onSetAutoTerms,
}: {
  projects: ProjectDto[];
  /** 選択中のプロジェクト。null は未所属の会話。 */
  projectId: string | null;
  onSelect: (projectId: string | null) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (projectId: string, name: string) => Promise<void>;
  onDelete: (projectId: string) => Promise<void>;
  onSetAutoTerms: (projectId: string, enabled: boolean) => Promise<void>;
}) => {
  const [dialog, setDialog] = useState<
    "create" | "rename" | "delete" | "settings"
  >();
  const current = projects.find((p) => p.id === projectId);
  /** 保存中の自動作成の設定（保存が終わるまで表示に使う）。 */
  const [autoTerms, setAutoTerms] = useState<boolean>();

  return (
    <div className="flex items-center gap-1 px-3 pb-2">
      <select
        className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm"
        aria-label="プロジェクト"
        value={projectId ?? UNASSIGNED}
        onChange={(event) =>
          onSelect(
            event.target.value === UNASSIGNED ? null : event.target.value,
          )
        }
      >
        <option value={UNASSIGNED}>未所属のスレッド</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label="新しいプロジェクト"
        title="新しいプロジェクト"
        onClick={() => setDialog("create")}
      >
        <FolderPlus className="size-4" />
      </Button>
      {current !== undefined && (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="プロジェクトの設定"
            title="プロジェクトの設定"
            onClick={() => setDialog("settings")}
          >
            <Settings className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="プロジェクトの名前を変える"
            title="プロジェクトの名前を変える"
            onClick={() => setDialog("rename")}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="プロジェクトを削除"
            title="プロジェクトを削除"
            onClick={() => setDialog("delete")}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </>
      )}
      <NameDialog
        open={dialog === "create"}
        title="新しいプロジェクト"
        initial=""
        submitLabel="作成"
        onClose={() => setDialog(undefined)}
        onSubmit={onCreate}
      />
      <NameDialog
        open={dialog === "rename"}
        title="プロジェクトの名前を変える"
        initial={current?.name ?? ""}
        submitLabel="保存"
        onClose={() => setDialog(undefined)}
        onSubmit={async (name) => {
          if (current !== undefined) await onRename(current.id, name);
        }}
      />
      <Dialog
        open={dialog === "settings"}
        onOpenChange={(open) => {
          if (!open) setDialog(undefined);
        }}
        title="プロジェクトの設定"
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
              このプロジェクトのスレッドで回答が終わるたびに、Claude（haiku）を追加で
              1 回呼び出して重要な用語を取り出し、Wiki
              に用語ページを作ります。その分、サブスクリプションの利用枠（API
              キーの場合は料金）を少し消費します。既存のページは書き換えません。
            </span>
          </span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDialog(undefined)}>
            閉じる
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog
        open={dialog === "delete"}
        onOpenChange={(open) => {
          if (!open) setDialog(undefined);
        }}
        title="プロジェクトを削除しますか？"
        description={`「${current?.name ?? ""}」を削除します。所属しているスレッドは削除されず、未所属に戻ります。`}
      >
        <DialogFooter>
          <Button variant="outline" onClick={() => setDialog(undefined)}>
            キャンセル
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (current !== undefined) await onDelete(current.id);
              setDialog(undefined);
            }}
          >
            削除
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
};

/** 未所属のスレッドを選んで、プロジェクトに追加するダイアログ。 */
export const AddThreadsDialog = ({
  open,
  projectName,
  candidates,
  onAdd,
  onClose,
}: {
  open: boolean;
  projectName: string;
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
    description={`未所属のスレッドを「${projectName}」に追加します。過去のメッセージはそのまま引き継がれます。`}
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
