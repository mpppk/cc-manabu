import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { asc, eq } from "drizzle-orm";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";
import {
  type ProjectLinkRow,
  type ProjectRow,
  projectLinks,
  projects,
} from "./schema.ts";

export class ProjectNotFoundError extends ErrorFactory({
  name: "ProjectNotFoundError",
  message: (fields) => `Project not found: ${fields.projectId}`,
  fields: ErrorFactory.fields<{ projectId: string }>(),
}) {}

export class ProjectLinkNotFoundError extends ErrorFactory({
  name: "ProjectLinkNotFoundError",
  message: (fields) => `Project link not found: ${fields.linkId}`,
  fields: ErrorFactory.fields<{ linkId: string }>(),
}) {}

const requireLink = (
  row: ProjectLinkRow | undefined,
  linkId: string,
): Result.Result<ProjectLinkRow, ProjectLinkNotFoundError> =>
  row === undefined
    ? Result.fail(new ProjectLinkNotFoundError({ linkId }))
    : Result.succeed(row);

const run = <T>(fn: () => T): Result.Result<T, DatabaseError> =>
  Result.try({ try: fn, catch: (cause) => new DatabaseError({ cause }) });

const requireProject = (
  row: ProjectRow | undefined,
  projectId: string,
): Result.Result<ProjectRow, ProjectNotFoundError> =>
  row === undefined
    ? Result.fail(new ProjectNotFoundError({ projectId }))
    : Result.succeed(row);

/** プロジェクトの永続化。会話の所属は chats.project_id に持つ。 */
export const createProjectRepository = (db: Db) => ({
  createProject: (input: {
    name: string;
    id?: string;
  }): Result.Result<ProjectRow, DatabaseError> =>
    run(() => {
      const now = new Date();
      return db
        .insert(projects)
        .values({
          id: input.id ?? crypto.randomUUID(),
          name: input.name,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    }),

  /** 作った順（並びが勝手に変わらないように）。 */
  listProjects: (): Result.Result<ProjectRow[], DatabaseError> =>
    run(() =>
      db.select().from(projects).orderBy(asc(projects.createdAt)).all(),
    ),

  getProject: (
    projectId: string,
  ): Result.Result<ProjectRow, ProjectNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.select().from(projects).where(eq(projects.id, projectId)).get(),
      ),
      Result.andThen((row) => requireProject(row, projectId)),
    ),

  renameProject: (
    projectId: string,
    name: string,
  ): Result.Result<ProjectRow, ProjectNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .update(projects)
          .set({ name, updatedAt: new Date() })
          .where(eq(projects.id, projectId))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireProject(row, projectId)),
    ),

  /** 回答からの用語ページの自動作成を切り替える。 */
  setAutoTerms: (
    projectId: string,
    enabled: boolean,
  ): Result.Result<ProjectRow, ProjectNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .update(projects)
          .set({ autoTerms: enabled, updatedAt: new Date() })
          .where(eq(projects.id, projectId))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireProject(row, projectId)),
    ),

  /** プロジェクトを消す。所属していた会話は消さず、未所属に戻す（外部キーの ON DELETE SET NULL）。 */
  deleteProject: (
    projectId: string,
  ): Result.Result<ProjectRow, ProjectNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db.delete(projects).where(eq(projects.id, projectId)).returning().get(),
      ),
      Result.andThen((row) => requireProject(row, projectId)),
    ),

  /** プロジェクトの関連リンク（登録した順）。 */
  listLinks: (
    projectId: string,
  ): Result.Result<ProjectLinkRow[], DatabaseError> =>
    run(() =>
      db
        .select()
        .from(projectLinks)
        .where(eq(projectLinks.projectId, projectId))
        .orderBy(asc(projectLinks.createdAt))
        .all(),
    ),

  createLink: (input: {
    projectId: string;
    url: string;
    label: string | null;
  }): Result.Result<ProjectLinkRow, DatabaseError> =>
    run(() => {
      const now = new Date();
      return db
        .insert(projectLinks)
        .values({
          id: crypto.randomUUID(),
          projectId: input.projectId,
          url: input.url,
          label: input.label,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    }),

  updateLink: (
    linkId: string,
    input: { url: string; label: string | null },
  ): Result.Result<ProjectLinkRow, ProjectLinkNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .update(projectLinks)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(projectLinks.id, linkId))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireLink(row, linkId)),
    ),

  deleteLink: (
    linkId: string,
  ): Result.Result<ProjectLinkRow, ProjectLinkNotFoundError | DatabaseError> =>
    Result.pipe(
      run(() =>
        db
          .delete(projectLinks)
          .where(eq(projectLinks.id, linkId))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireLink(row, linkId)),
    ),
});

export type ProjectRepository = ReturnType<typeof createProjectRepository>;
