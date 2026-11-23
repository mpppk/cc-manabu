import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { asc, eq } from "drizzle-orm";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";
import { type ProjectRow, projects } from "./schema.ts";

export class ProjectNotFoundError extends ErrorFactory({
  name: "ProjectNotFoundError",
  message: (fields) => `Project not found: ${fields.projectId}`,
  fields: ErrorFactory.fields<{ projectId: string }>(),
}) {}

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
});

export type ProjectRepository = ReturnType<typeof createProjectRepository>;
