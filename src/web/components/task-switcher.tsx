import {
  FolderPlus,
  Pencil,
  Settings,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import type { TaskDto, WikiDto } from "../../router.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogFooter } from "./ui/dialog.tsx";
import { DropdownMenu } from "./ui/dropdown-menu.tsx";

/** 未所属の会話を表す select の値。 */
const UNASSIGNED = "";

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
  onClose,
  onSubmit,
}: {
  open: boolean;
  wikis: WikiDto[];
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
      setUseExisting(false);
      setWikiId(wikis[0]?.id ?? "");
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

const GROUP_KEY = "cc-manabu.groupTasksByWiki";

const loadGroupByWiki = (): boolean => {
  try {
    return localStorage.getItem(GROUP_KEY) === "1";
  } catch {
    return false;
  }
};

/** タスクの一覧を参照している Wiki ごとにまとめるか（ブラウザに覚える）。 */
export const useGroupByWiki = () => {
  const [groupByWiki, setGroupByWiki] = useState(loadGroupByWiki);
  const set = (next: boolean) => {
    setGroupByWiki(next);
    try {
      localStorage.setItem(GROUP_KEY, next ? "1" : "0");
    } catch {
      // 覚えられなくても表示は切り替える
    }
  };
  return [groupByWiki, set] as const;
};

/** 「参照している Wiki ごとにまとめる」のチェックボックス。 */
export const GroupByWikiToggle = ({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) => (
  <label className="flex items-center gap-1.5 px-3 pb-2 text-muted-foreground text-xs">
    <input
      type="checkbox"
      className="size-3.5"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
    />
    参照している Wiki ごとにまとめる
  </label>
);

/** サイドバー上部のタスク選択（作成・名前変更・削除）。 */
export const TaskSwitcher = ({
  tasks,
  taskId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onSetAutoTerms,
  wikis,
  onRenameWiki,
  groupByWiki,
}: {
  tasks: TaskDto[];
  /** 一覧を参照している Wiki ごとにまとめるか。 */
  groupByWiki: boolean;
  /** Wiki（複数のタスクで共有できる）。 */
  wikis: WikiDto[];
  onRenameWiki: (wikiId: string, name: string) => Promise<void>;
  /** 選択中のタスク。null は未所属の会話。 */
  taskId: string | null;
  onSelect: (taskId: string | null) => void;
  /** wikiId を渡すとその Wiki を共有し、無ければ新しい Wiki を作る。 */
  onCreate: (name: string, wikiId?: string) => Promise<void>;
  onRename: (taskId: string, name: string) => Promise<void>;
  onDelete: (taskId: string) => Promise<void>;
  onSetAutoTerms: (taskId: string, enabled: boolean) => Promise<void>;
}) => {
  const [dialog, setDialog] = useState<
    "create" | "rename" | "delete" | "settings"
  >();
  const current = tasks.find((p) => p.id === taskId);
  /** 保存中の自動作成の設定（保存が終わるまで表示に使う）。 */
  const [autoTerms, setAutoTerms] = useState<boolean>();
  const currentWiki = wikis.find((wiki) => wiki.id === current?.wikiId);
  /** 今のタスクと同じ Wiki を使う、ほかのタスク。 */
  const sharing = tasks.filter(
    (p) =>
      current !== undefined &&
      p.wikiId === current.wikiId &&
      p.id !== current.id,
  );

  const optionOf = (task: TaskDto) => (
    <option key={task.id} value={task.id}>
      {task.status === "done" ? `${task.name}（完了）` : task.name}
    </option>
  );
  const grouped = wikis.flatMap((wiki) => {
    const members = tasks.filter((p) => p.wikiId === wiki.id);
    return members.length === 0 ? [] : [{ wiki, members }];
  });
  const ungrouped = tasks.filter(
    (p) => !wikis.some((wiki) => wiki.id === p.wikiId),
  );

  return (
    <div className="flex flex-col gap-1 px-3 pb-2">
      <div className="flex items-center gap-1">
        <select
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm"
          aria-label="タスク"
          value={taskId ?? UNASSIGNED}
          onChange={(event) =>
            onSelect(
              event.target.value === UNASSIGNED ? null : event.target.value,
            )
          }
        >
          <option value={UNASSIGNED}>未所属のスレッド</option>
          {groupByWiki ? (
            <>
              {grouped.map(({ wiki, members }) => (
                <optgroup key={wiki.id} label={`Wiki: ${wiki.name}`}>
                  {members.map(optionOf)}
                </optgroup>
              ))}
              {ungrouped.map(optionOf)}
            </>
          ) : (
            tasks.map(optionOf)
          )}
        </select>
        <DropdownMenu
          label="タスクのメニュー"
          icon={<Settings className="size-3.5" />}
          items={[
            {
              label: "新しいタスク",
              icon: <FolderPlus />,
              onSelect: () => setDialog("create"),
            },
            ...(current === undefined
              ? []
              : [
                  {
                    label: "タスクの設定",
                    icon: <SlidersHorizontal />,
                    onSelect: () => setDialog("settings"),
                    separatorBefore: true,
                  },
                  {
                    label: "タスクの名前を変える",
                    icon: <Pencil />,
                    onSelect: () => setDialog("rename"),
                  },
                  {
                    label: "タスクを削除",
                    icon: <Trash2 />,
                    onSelect: () => setDialog("delete"),
                    variant: "destructive" as const,
                  },
                ]),
          ]}
        />
      </div>
      <CreateTaskDialog
        open={dialog === "create"}
        wikis={wikis}
        onClose={() => setDialog(undefined)}
        onSubmit={(name, wikiId) => onCreate(name, wikiId)}
      />
      <NameDialog
        open={dialog === "rename"}
        title="タスクの名前を変える"
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
        title="タスクを削除しますか？"
        description={`「${current?.name ?? ""}」を削除します。所属しているスレッドは削除されず、未所属に戻ります。${
          sharing.length > 0
            ? `Wiki「${currentWiki?.name ?? ""}」はほかのタスクでも使っているので残ります。`
            : `Wiki「${currentWiki?.name ?? ""}」とそのページも削除されます。`
        }`}
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
