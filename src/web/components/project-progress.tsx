import { ClipboardList } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { ProjectStatus } from "../../db/schema.ts";
import type { ProjectDto } from "../../router.ts";
import type { ApiClient } from "../lib/orpc.ts";
import {
  formatDateTime,
  isProjectStatus,
  PROJECT_STATUS_CLASSES,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_ORDER,
} from "../lib/project-status.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";

export const ProjectStatusBadge = ({ status }: { status: ProjectStatus }) => (
  <span
    className={cn(
      "shrink-0 rounded px-1.5 py-0.5 text-xs",
      PROJECT_STATUS_CLASSES[status],
    )}
  >
    {PROJECT_STATUS_LABELS[status]}
  </span>
);

/** プロジェクトの進捗（状態・進捗メモ・次にやること）。状態は選ぶとすぐ保存する。 */
export const ProjectProgress = ({
  api,
  project,
  onChanged,
}: {
  api: ApiClient;
  project: ProjectDto;
  onChanged: () => Promise<void>;
}) => {
  const [note, setNote] = useState(project.progressNote);
  const [next, setNext] = useState(project.nextAction);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const dirty =
    note !== project.progressNote || next.trim() !== project.nextAction;

  const update = async (
    progress: Parameters<ApiClient["projects"]["updateProgress"]>[0],
  ) => {
    setError(undefined);
    try {
      await api.projects.updateProgress(progress);
      await onChanged();
      return true;
    } catch {
      setError("保存できませんでした。");
      return false;
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    if (
      await update({ id: project.id, progressNote: note, nextAction: next })
    ) {
      setSaved(true);
    }
  };

  return (
    <section aria-labelledby="project-progress" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="project-progress"
          className="flex items-center gap-2 font-semibold text-base"
        >
          <ClipboardList className="size-4" />
          進捗
        </h2>
        <span className="text-muted-foreground text-xs">
          最終更新: {formatDateTime(project.progressUpdatedAt)}
        </span>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <span className="w-24 shrink-0 text-muted-foreground">状態</span>
        <select
          className="rounded-md border bg-background px-2 py-1.5 text-sm"
          aria-label="状態"
          value={project.status}
          onChange={(event) => {
            if (isProjectStatus(event.target.value)) {
              void update({ id: project.id, status: event.target.value });
            }
          }}
        >
          {PROJECT_STATUS_ORDER.map((status) => (
            <option key={status} value={status}>
              {PROJECT_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <ProjectStatusBadge status={project.status} />
      </label>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <label className="flex items-start gap-3 text-sm">
          <span className="mt-2 w-24 shrink-0 text-muted-foreground">
            次にやること
          </span>
          <input
            className="flex-1 rounded-md border bg-background px-3 py-1.5"
            aria-label="次にやること"
            placeholder="例: 検証環境で権限モデルを試す"
            maxLength={500}
            value={next}
            onChange={(event) => {
              setNext(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="flex items-start gap-3 text-sm">
          <span className="mt-2 w-24 shrink-0 text-muted-foreground">
            進捗メモ
          </span>
          <textarea
            className="min-h-24 flex-1 resize-y rounded-md border bg-background px-3 py-2"
            aria-label="進捗メモ"
            placeholder="どこまで進んだか、決めたこと、再開時に見るものなど"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <div className="flex items-center justify-end gap-3">
          {error !== undefined && (
            <span className="text-destructive text-sm" role="alert">
              {error}
            </span>
          )}
          {saved && !dirty && (
            <span className="text-muted-foreground text-sm" role="status">
              保存しました
            </span>
          )}
          <Button type="submit" size="sm" disabled={!dirty}>
            進捗を保存
          </Button>
        </div>
      </form>
    </section>
  );
};
