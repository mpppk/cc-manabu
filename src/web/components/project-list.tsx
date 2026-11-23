import { useState } from "react";
import type { ProjectStatus } from "../../db/schema.ts";
import type { ProjectDto } from "../../router.ts";
import {
  formatDateTime,
  isProjectStatus,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_ORDER,
} from "../lib/project-status.ts";
import { ProjectStatusBadge } from "./project-progress.tsx";
import { Button } from "./ui/button.tsx";

/** URL の ?status= から絞り込みを読む（リロードしても保つ）。 */
const statusFromUrl = (): ProjectStatus | undefined => {
  const value = new URLSearchParams(window.location.search).get("status");
  return value !== null && isProjectStatus(value) ? value : undefined;
};

/** プロジェクト一覧（`/projects`）。状態・次にやること・進捗の最終更新を並べ、状態で絞り込む。 */
export const ProjectList = ({
  projects,
  onOpen,
}: {
  projects: ProjectDto[];
  onOpen: (projectId: string) => void;
}) => {
  const [filter, setFilter] = useState<ProjectStatus | undefined>(
    statusFromUrl,
  );
  const choose = (next: ProjectStatus | undefined) => {
    setFilter(next);
    const url = new URL(window.location.href);
    if (next === undefined) url.searchParams.delete("status");
    else url.searchParams.set("status", next);
    window.history.replaceState(window.history.state, "", url);
  };
  const visible =
    filter === undefined
      ? projects
      : projects.filter((project) => project.status === filter);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
        <h1 className="font-bold text-2xl">プロジェクト一覧</h1>
        <nav aria-label="状態で絞り込む" className="flex flex-wrap gap-1">
          {[undefined, ...PROJECT_STATUS_ORDER].map((status) => (
            <Button
              key={status ?? "all"}
              size="sm"
              variant={filter === status ? "secondary" : "ghost"}
              aria-pressed={filter === status}
              onClick={() => choose(status)}
            >
              {status === undefined ? "すべて" : PROJECT_STATUS_LABELS[status]}
              <span className="text-muted-foreground text-xs">
                {status === undefined
                  ? projects.length
                  : projects.filter((p) => p.status === status).length}
              </span>
            </Button>
          ))}
        </nav>
        {visible.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {projects.length === 0
              ? "まだプロジェクトがありません。サイドバーから作成できます。"
              : "この状態のプロジェクトはありません。"}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground text-xs">
              <tr className="border-b">
                <th className="py-2 pr-3 font-normal">名前</th>
                <th className="py-2 pr-3 font-normal">状態</th>
                <th className="py-2 pr-3 font-normal">次にやること</th>
                <th className="py-2 font-normal">進捗の最終更新</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((project) => (
                <tr key={project.id} className="border-b align-top">
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      className="text-left font-medium text-primary hover:underline"
                      onClick={() => onOpen(project.id)}
                    >
                      {project.name}
                    </button>
                  </td>
                  <td className="py-2 pr-3">
                    <ProjectStatusBadge status={project.status} />
                  </td>
                  <td className="py-2 pr-3">
                    {project.nextAction === "" ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      project.nextAction
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2 text-muted-foreground">
                    {formatDateTime(project.progressUpdatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
