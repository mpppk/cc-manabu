import { ExternalLink, Link2, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { ProjectLinkDto } from "../../router.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { Button } from "./ui/button.tsx";

/** http / https の URL か（サーバでも同じ検証をする）。 */
export const isHttpUrl = (value: string): boolean =>
  URL.canParse(value.trim()) &&
  /^https?:$/.test(new URL(value.trim()).protocol);

const URL_ERROR = "http または https の URL を入力してください。";

/** URL と表示名の入力（追加・編集で共用）。 */
const LinkForm = ({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { url: string; label: string };
  submitLabel: string;
  onSubmit: (link: { url: string; label: string }) => Promise<void>;
  onCancel?: () => void;
}) => {
  const [url, setUrl] = useState(initial.url);
  const [label, setLabel] = useState(initial.label);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isHttpUrl(url)) {
      setError(URL_ERROR);
      return;
    }
    setError(undefined);
    const value = { url: url.trim(), label: label.trim() };
    // 保存を待つ間に次の入力を始められるよう、先に空にする（失敗したら戻す）
    setUrl(initial.url);
    setLabel(initial.label);
    try {
      await onSubmit(value);
    } catch {
      setUrl(value.url);
      setLabel(value.label);
      setError("保存できませんでした。");
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <div className="flex flex-wrap gap-2">
        <input
          className="min-w-48 flex-[2] rounded-md border bg-background px-3 py-1.5 text-sm"
          aria-label="URL"
          placeholder="https://github.com/…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <input
          className="min-w-32 flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
          aria-label="表示名（任意）"
          placeholder="表示名（任意）"
          maxLength={200}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={url.trim() === ""}>
          {submitLabel}
        </Button>
        {onCancel !== undefined && (
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            キャンセル
          </Button>
        )}
      </div>
      {error !== undefined && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </form>
  );
};

/** プロジェクトの関連リンク（一覧・追加・編集・削除）。 */
export const ProjectLinks = ({
  api,
  projectId,
}: {
  api: ApiClient;
  projectId: string;
}) => {
  const [links, setLinks] = useState<ProjectLinkDto[]>();
  const [editing, setEditing] = useState<string>();

  const refresh = useCallback(async () => {
    setLinks(await api.links.list({ projectId }).catch(() => []));
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section aria-labelledby="project-links" className="flex flex-col gap-3">
      <h2
        id="project-links"
        className="flex items-center gap-2 font-semibold text-base"
      >
        <Link2 className="size-4" />
        関連リンク
      </h2>
      {links === undefined ? (
        <p className="text-muted-foreground text-sm">読み込み中…</p>
      ) : links.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          リポジトリや設計資料など、よく開く URL を登録できます。
        </p>
      ) : (
        <ul aria-label="関連リンク" className="flex flex-col gap-1">
          {links.map((link) =>
            editing === link.id ? (
              <li key={link.id} className="rounded-md border p-2">
                <LinkForm
                  initial={{ url: link.url, label: link.label ?? "" }}
                  submitLabel="保存"
                  onCancel={() => setEditing(undefined)}
                  onSubmit={async ({ url, label }) => {
                    await api.links.update({ id: link.id, url, label });
                    setEditing(undefined);
                    await refresh();
                  }}
                />
              </li>
            ) : (
              <li
                key={link.id}
                className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
              >
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-w-0 flex-1 items-center gap-2"
                >
                  <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-primary underline-offset-2 hover:underline">
                    {link.label ?? link.url}
                  </span>
                  {link.label !== null && (
                    <span className="truncate text-muted-foreground text-xs">
                      {link.url}
                    </span>
                  )}
                </a>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`「${link.label ?? link.url}」を編集`}
                  onClick={() => setEditing(link.id)}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`「${link.label ?? link.url}」を削除`}
                  onClick={async () => {
                    await api.links.delete({ id: link.id });
                    await refresh();
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ),
          )}
        </ul>
      )}
      <div className="flex items-start gap-2">
        <Plus className="mt-2 size-4 shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <LinkForm
            initial={{ url: "", label: "" }}
            submitLabel="追加"
            onSubmit={async ({ url, label }) => {
              await api.links.create({ projectId, url, label });
              await refresh();
            }}
          />
        </div>
      </div>
    </section>
  );
};
