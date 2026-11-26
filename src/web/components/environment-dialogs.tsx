import { ArrowUp, FolderOpen, Loader2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { EnvironmentDto, WikiDto } from "../../router.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogFooter } from "./ui/dialog.tsx";

/** 環境の作成・変更で送る値。wikiId が無ければ新しい Wiki を作る。 */
export type EnvironmentInput = {
  name: string;
  directories: string[];
  /** 環境の目的や扱うテーマ（空欄でもよい）。 */
  description: string;
  wikiId?: string;
};

/** 環境の操作で開くダイアログ。 */
export type EnvironmentDialog =
  | { kind: "create" }
  | { kind: "settings" | "delete"; environmentId: string };

/** パスの最後の名前（フォルダ名）。 */
const folderName = (path: string): string =>
  path
    .split(/[\\/]/)
    .filter((part) => part !== "")
    .at(-1) ?? path;

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message !== ""
    ? error.message
    : "保存できませんでした。";

/** ディレクトリの一覧と、追加の欄（パスの入力・フォルダを選ぶダイアログ）。 */
const DirectoryList = ({
  directories,
  onChange,
  onPick,
}: {
  directories: string[];
  onChange: (directories: string[]) => void;
  onPick: () => Promise<string | null>;
}) => {
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === "") return;
    if (!directories.includes(trimmed)) onChange([...directories, trimmed]);
    setPath("");
  };

  return (
    <fieldset className="grid min-w-0 grid-cols-1 gap-2 text-sm">
      <legend className="mb-1 font-medium">ディレクトリ</legend>
      {directories.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          ディレクトリを 1 つ以上追加してください。
        </p>
      ) : (
        <ul
          aria-label="環境のディレクトリ"
          className="grid min-w-0 grid-cols-1 gap-1"
        >
          {directories.map((directory, index) => (
            <li
              key={directory}
              className="flex items-center gap-2 rounded-md border px-2 py-1"
            >
              <span
                className="flex min-w-0 flex-1 flex-col"
                title={directory}
                data-directory={directory}
              >
                <span className="truncate text-sm">
                  {folderName(directory)}
                </span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">
                  {directory}
                </span>
              </span>
              {index === 0 ? (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  作業ディレクトリ
                </span>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={`${directory} を作業ディレクトリにする`}
                  title="作業ディレクトリにする（先頭に移す）"
                  onClick={() =>
                    onChange([
                      directory,
                      ...directories.filter((d) => d !== directory),
                    ])
                  }
                >
                  <ArrowUp className="size-3.5" />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={`${directory} を外す`}
                title="外す"
                onClick={() =>
                  onChange(directories.filter((d) => d !== directory))
                }
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-md border bg-background px-3 py-1.5 font-mono text-xs"
          aria-label="追加するディレクトリのパス"
          placeholder="/Users/me/repo または ~/repo"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            // Enter で環境の保存ではなく、ディレクトリの追加にする
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              add(path);
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={path.trim() === ""}
          onClick={() => add(path)}
        >
          追加
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={picking}
          onClick={async () => {
            setPicking(true);
            setPickError(undefined);
            try {
              const picked = await onPick();
              if (picked !== null) add(picked);
            } catch (error) {
              setPickError(errorMessage(error));
            } finally {
              setPicking(false);
            }
          }}
        >
          {picking ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          選ぶ
        </Button>
      </div>
      {pickError !== undefined && (
        <p role="alert" className="text-destructive text-xs">
          {pickError}
        </p>
      )}
      <span className="text-muted-foreground text-xs">
        先頭のディレクトリが新しいスレッドの作業ディレクトリになり、残りは追加のディレクトリとして
        Claude Code
        が読み書きできます。作ったスレッドの作業ディレクトリは変わりません。
      </span>
    </fieldset>
  );
};

/** 環境を作る・変えるダイアログ。 */
const EnvironmentFormDialog = ({
  open,
  environment,
  wikis,
  defaultDirectory,
  onClose,
  onSubmit,
  onPickDirectory,
}: {
  open: boolean;
  /** 変える環境。無ければ新しく作る。 */
  environment: EnvironmentDto | undefined;
  wikis: WikiDto[];
  /** 新しく作るときに最初から入れておくディレクトリ（起動したディレクトリ）。 */
  defaultDirectory: string | undefined;
  onClose: () => void;
  onSubmit: (input: EnvironmentInput & { wikiName?: string }) => Promise<void>;
  onPickDirectory: () => Promise<string | null>;
}) => {
  const [name, setName] = useState("");
  const [directories, setDirectories] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [useExisting, setUseExisting] = useState(false);
  const [wikiId, setWikiId] = useState("");
  const [wikiName, setWikiName] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);
  // 開き直すたびに初期値に戻す
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setName(environment?.name ?? "");
      setDirectories(
        environment?.directories ??
          (defaultDirectory === undefined ? [] : [defaultDirectory]),
      );
      setDescription(environment?.description ?? "");
      setUseExisting(environment !== undefined);
      setWikiId(environment?.wikiId ?? wikis[0]?.id ?? "");
      setWikiName(environment?.wikiName ?? "");
      setError(undefined);
    }
  }
  const editing = environment !== undefined;
  const chosenWiki = useExisting
    ? wikis.find((wiki) => wiki.id === wikiId)
    : undefined;
  const valid =
    name.trim() !== "" &&
    directories.length > 0 &&
    (!useExisting || chosenWiki !== undefined) &&
    (!editing || wikiName.trim() !== "");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSubmit({
        name: name.trim(),
        directories,
        description: description.trim(),
        ...(chosenWiki === undefined ? {} : { wikiId: chosenWiki.id }),
        ...(editing ? { wikiName: wikiName.trim() } : {}),
      });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={editing ? "環境の設定" : "新しい環境"}
      description="環境は、Claude Code が作業するディレクトリと、回答で参照する Wiki の組み合わせです。タスクは 1 つの環境に属します。"
    >
      <form className="grid min-w-0 grid-cols-1 gap-4" onSubmit={submit}>
        <input
          className="rounded-md border bg-background px-3 py-2 text-sm"
          aria-label="環境の名前"
          placeholder="例: cc-manabu"
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <DirectoryList
          directories={directories}
          onChange={setDirectories}
          onPick={onPickDirectory}
        />
        <label className="grid min-w-0 grid-cols-1 gap-1 text-sm">
          <span className="font-medium">説明（任意）</span>
          <textarea
            className="min-h-16 resize-y rounded-md border bg-background px-3 py-2 text-sm"
            aria-label="環境の説明"
            placeholder="例: 個人情報の取扱いを検討する"
            maxLength={2000}
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <span className="text-muted-foreground text-xs">
            環境の目的や扱うテーマ。回答から用語ノートを自動作成するとき、このテーマに沿った語を選びます。
          </span>
        </label>
        <fieldset className="grid min-w-0 grid-cols-1 gap-2 text-sm">
          <legend className="mb-1 font-medium">Wiki</legend>
          {!editing && (
            <>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="environment-wiki"
                  checked={!useExisting}
                  onChange={() => setUseExisting(false)}
                />
                新しい Wiki を作る
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="environment-wiki"
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
            </>
          )}
          {useExisting && (
            <select
              className={
                editing
                  ? "rounded-md border bg-background px-2 py-1.5"
                  : "ml-6 rounded-md border bg-background px-2 py-1.5"
              }
              aria-label="参照する Wiki"
              value={wikiId}
              onChange={(event) => {
                setWikiId(event.target.value);
                setWikiName(
                  wikis.find((wiki) => wiki.id === event.target.value)?.name ??
                    "",
                );
              }}
            >
              {wikis.map((wiki) => (
                <option key={wiki.id} value={wiki.id}>
                  {wiki.name}
                </option>
              ))}
            </select>
          )}
          {editing && (
            <input
              className="rounded-md border bg-background px-3 py-1.5 text-sm"
              aria-label="Wiki の名前"
              maxLength={100}
              value={wikiName}
              onChange={(event) => setWikiName(event.target.value)}
            />
          )}
          <span className="text-muted-foreground text-xs">
            環境のタスクのスレッドは、この Wiki
            のノートを回答の参照資料に使い、用語ノートもこの Wiki
            に作ります。同じ Wiki をほかの環境と共有することもできます。
          </span>
        </fieldset>
        {error !== undefined && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" disabled={!valid || saving}>
            {editing ? "保存" : "作成"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
};

/** 環境の作成・設定・削除のダイアログ。 */
export const EnvironmentDialogs = ({
  dialog,
  onClose,
  environments,
  wikis,
  defaultDirectory,
  onCreate,
  onUpdate,
  onRenameWiki,
  onDelete,
  onPickDirectory,
}: {
  dialog: EnvironmentDialog | undefined;
  onClose: () => void;
  environments: EnvironmentDto[];
  wikis: WikiDto[];
  defaultDirectory: string | undefined;
  onCreate: (input: EnvironmentInput) => Promise<void>;
  onUpdate: (environmentId: string, input: EnvironmentInput) => Promise<void>;
  onRenameWiki: (wikiId: string, name: string) => Promise<void>;
  onDelete: (environmentId: string) => Promise<void>;
  onPickDirectory: () => Promise<string | null>;
}) => {
  const current =
    dialog === undefined || dialog.kind === "create"
      ? undefined
      : environments.find((e) => e.id === dialog.environmentId);
  const wikiShared =
    current !== undefined &&
    environments.some(
      (e) => e.id !== current.id && e.wikiId === current.wikiId,
    );

  return (
    <>
      <EnvironmentFormDialog
        open={
          dialog?.kind === "create" ||
          (dialog?.kind === "settings" && current !== undefined)
        }
        environment={dialog?.kind === "settings" ? current : undefined}
        wikis={wikis}
        defaultDirectory={defaultDirectory}
        onClose={onClose}
        onPickDirectory={onPickDirectory}
        onSubmit={async ({ wikiName, ...input }) => {
          if (dialog?.kind === "settings" && current !== undefined) {
            await onUpdate(current.id, input);
            const wikiId = input.wikiId ?? current.wikiId;
            const before = wikis.find((wiki) => wiki.id === wikiId)?.name;
            if (wikiName !== undefined && wikiName !== before) {
              await onRenameWiki(wikiId, wikiName);
            }
          } else {
            await onCreate(input);
          }
        }}
      />
      <Dialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={
          current !== undefined && current.taskCount > 0
            ? "この環境は削除できません"
            : "環境を削除しますか？"
        }
        description={
          current === undefined
            ? ""
            : current.taskCount > 0
              ? `「${current.name}」には ${current.taskCount} 件のタスクがあります。タスクを別の環境に移すか、削除してから削除してください。`
              : `「${current.name}」を削除します。ディレクトリの中身は消えません。${
                  wikiShared
                    ? `Wiki「${current.wikiName}」はほかの環境でも使っているので残ります。`
                    : `Wiki「${current.wikiName}」とそのノートも削除されます。`
                }`
        }
      >
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {current !== undefined && current.taskCount > 0
              ? "閉じる"
              : "キャンセル"}
          </Button>
          {current !== undefined && current.taskCount === 0 && (
            <Button
              variant="destructive"
              onClick={async () => {
                await onDelete(current.id);
                onClose();
              }}
            >
              削除
            </Button>
          )}
        </DialogFooter>
      </Dialog>
    </>
  );
};
