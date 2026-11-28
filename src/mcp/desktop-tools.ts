/**
 * Claude Desktop から monet の Wiki とタスクを読み書きするツールの処理（#212）。
 * monet のスレッドに渡すツール（src/wiki/tools.ts、src/task/tools.ts）の処理を再利用する。
 *
 * Claude Desktop の会話には monet の所属タスクが無いので、対象のタスクは利用者が選び、
 * ツールには task_id で明示する。Wiki は、そのタスクが参照するものを使う。
 * 結果は Claude に返すテキスト。
 */
import { homedir } from "node:os";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import type { DatabaseError } from "../db/chat-repository.ts";
import {
  EnvironmentNotFoundError,
  type EnvironmentRepository,
  type EnvironmentSummary,
} from "../db/environment-repository.ts";
import type { TaskRow, TaskStatus } from "../db/schema.ts";
import {
  TaskNotFoundError,
  type TaskRepository,
} from "../db/task-repository.ts";
import type { WikiRepository } from "../db/wiki-repository.ts";
import {
  type DirectoryError,
  normalizeDirectories,
} from "../environment/directories.ts";
import { taskName } from "../task/inputs.ts";
import { createTaskToolHandlers, type TaskToolError } from "../task/tools.ts";
import { TASK_STATUS_LABELS } from "../web/lib/task-status.ts";
import { createWikiToolHandlers, type WikiToolError } from "../wiki/tools.ts";

/** ツールの入力が使えないとき。message はそのまま Claude に返す。 */
export class DesktopToolInputError extends ErrorFactory({
  name: "DesktopToolInputError",
  message: (fields) => fields.reason,
  fields: ErrorFactory.fields<{ reason: string }>(),
}) {}

export type DesktopToolError =
  | DesktopToolInputError
  | DirectoryError
  | EnvironmentNotFoundError
  | WikiToolError
  | TaskToolError;

export type DesktopToolDeps = {
  tasks: TaskRepository;
  environments: Pick<
    EnvironmentRepository,
    "listEnvironments" | "getEnvironment"
  >;
  wiki: Pick<
    WikiRepository,
    "listPages" | "getPage" | "createPage" | "updatePage"
  >;
  /** 新しい環境の作業ディレクトリの既定（利用者のホームディレクトリ）。 */
  defaultDirectory?: string;
};

const fail = (reason: string) =>
  Result.fail(new DesktopToolInputError({ reason }));

/** タスクの選び方。対象が分からないときのエラーに添える。 */
const HOW_TO_PICK_TASK =
  "list_tasks でタスクを探し、利用者に対象を確かめてから、その id を task_id に指定してください。";

const statusText = (status: TaskStatus) =>
  `${TASK_STATUS_LABELS[status]}（${status}）`;

const taskLine = (task: TaskRow, environmentName: string | undefined) =>
  `- ${task.name}（task_id: ${task.id}、状態: ${statusText(task.status)}${task.archivedAt === null ? "" : "、アーカイブ済み"}、環境: ${environmentName ?? "（不明）"}）`;

const environmentLine = (environment: EnvironmentSummary) =>
  `- ${environment.name}（environment_id: ${environment.id}、Wiki: ${environment.wikiName ?? "（使わない）"}、タスク ${environment.taskCount} 件、ディレクトリ: ${environment.directories.join(", ") || "（なし）"}）`;

export const createDesktopToolHandlers = (deps: DesktopToolDeps) => {
  const { tasks, environments } = deps;

  const environmentNames = () =>
    Result.pipe(
      environments.listEnvironments(),
      Result.map(
        (list) =>
          new Map(list.map((environment) => [environment.id, environment])),
      ),
    );

  /** task_id のタスク。指定が無い・見つからないときは、選び方の分かるエラーにする。 */
  const taskOf = (
    taskId: string | undefined,
  ): Result.Result<TaskRow, DesktopToolInputError | DatabaseError> => {
    if (taskId === undefined || taskId.trim() === "") {
      return fail(`対象のタスクが指定されていません。${HOW_TO_PICK_TASK}`);
    }
    return Result.pipe(
      tasks.getTask(taskId.trim()),
      Result.orElse((error) =>
        error instanceof TaskNotFoundError
          ? fail(
              `タスクが見つかりません（task_id: ${taskId}）。${HOW_TO_PICK_TASK}`,
            )
          : Result.fail(error),
      ),
    );
  };

  /** environment_id の環境。見つからないときは、選び方の分かるエラーにする。 */
  const environmentOf = (environmentId: string) =>
    Result.pipe(
      environments.getEnvironment(environmentId),
      Result.orElse((error) =>
        error instanceof EnvironmentNotFoundError
          ? fail(
              `環境が見つかりません（environment_id: ${environmentId}）。list_environments で id を確かめてください。`,
            )
          : Result.fail(error),
      ),
    );

  /** タスクの情報に、所属の環境と参照する Wiki を添える。 */
  const describeTask = (task: TaskRow) =>
    Result.pipe(
      Result.do(),
      Result.bind("text", () =>
        createTaskToolHandlers(deps, task.id).getTask(),
      ),
      Result.bind("environments", () => environmentNames()),
      Result.map(({ text, environments: byId }) => {
        const environment = byId.get(task.environmentId ?? "");
        return [
          `task_id: ${task.id}`,
          text,
          `環境: ${environment === undefined ? "（不明）" : `${environment.name}（environment_id: ${environment.id}）`}`,
          environment !== undefined && environment.wikiName === null
            ? "Wiki: （この環境は Wiki を使っていません）"
            : `Wiki: ${environment?.wikiName ?? "（不明）"}（list_pages・read_page で読めます）`,
        ].join("\n");
      }),
    );

  const wikiHandlers = (taskId: string) =>
    // Claude Desktop からの変更として版に残す。変更ごとに 1 つのまとまりにする（元に戻す単位）
    createWikiToolHandlers(deps, { taskId, actor: "claude_desktop" });

  const withTask = <T>(
    taskId: string | undefined,
    fn: (task: TaskRow) => Result.Result<T, DesktopToolError>,
  ): Result.Result<T, DesktopToolError> =>
    Result.pipe(taskOf(taskId), Result.andThen(fn));

  return {
    listTasks: (input: {
      query?: string | undefined;
    }): Result.Result<string, DesktopToolError> =>
      Result.pipe(
        Result.do(),
        Result.bind("tasks", () => tasks.listTasks()),
        Result.bind("environments", () => environmentNames()),
        Result.map(({ tasks: all, environments: byId }) => {
          const query = input.query?.trim().toLowerCase() ?? "";
          const matched =
            query === ""
              ? all
              : all.filter((task) => {
                  const environment = byId.get(task.environmentId ?? "");
                  return [task.name, environment?.name ?? ""].some((name) =>
                    name.toLowerCase().includes(query),
                  );
                });
          if (matched.length === 0) {
            return query === ""
              ? "monet にタスクはまだありません。create_task で作れます。"
              : `「${input.query}」に一致するタスクはありません。query を外すと全件を返します。`;
          }
          return [
            `タスク（${matched.length} 件）:`,
            ...matched.map((task) =>
              taskLine(task, byId.get(task.environmentId ?? "")?.name),
            ),
          ].join("\n");
        }),
      ),

    listEnvironments: (): Result.Result<string, DesktopToolError> =>
      Result.pipe(
        environments.listEnvironments(),
        Result.map((list) =>
          list.length === 0
            ? "monet に環境はまだありません。create_task で新しい環境ごと作れます。"
            : [`環境（${list.length} 件）:`, ...list.map(environmentLine)].join(
                "\n",
              ),
        ),
      ),

    getTask: (input: {
      task_id?: string | undefined;
    }): Result.Result<string, DesktopToolError> =>
      withTask(input.task_id, describeTask),

    createTask: (input: {
      name: string;
      environment_id?: string | undefined;
      directory?: string | undefined;
    }): Result.Result<string, DesktopToolError> => {
      const name = taskName.safeParse(input.name);
      if (!name.success) {
        return fail(
          `name: ${name.error.issues[0]?.message ?? "不正な値です。"}`,
        );
      }
      if (input.environment_id !== undefined && input.directory !== undefined) {
        return fail(
          "environment_id と directory は同時に指定できません。既存の環境に入れるなら environment_id、新しい環境を作るなら directory（省略可）を指定してください。",
        );
      }
      const created =
        input.environment_id === undefined
          ? Result.pipe(
              // monet のタスク作成画面と同じく、タスクと同じ名前の環境と Wiki を新しく作る
              normalizeDirectories([
                input.directory ?? deps.defaultDirectory ?? homedir(),
              ]),
              Result.andThen((directories) =>
                tasks.createTask({ name: name.data, directories }),
              ),
            )
          : Result.pipe(
              environmentOf(input.environment_id),
              Result.andThen((environment) =>
                tasks.createTask({
                  name: name.data,
                  environmentId: environment.id,
                }),
              ),
            );
      return Result.pipe(
        created,
        Result.andThen(describeTask),
        Result.map((text) => `タスクを作成しました。\n${text}`),
      );
    },

    updateTask: (input: {
      task_id?: string | undefined;
      name?: string | undefined;
      status?: TaskStatus | undefined;
      progress_note?: string | undefined;
      goal?: string | undefined;
      environment_id?: string | undefined;
    }): Result.Result<string, DesktopToolError> =>
      withTask(input.task_id, (task) => {
        const { task_id: _, environment_id, ...fields } = input;
        const changesFields = Object.values(fields).some(
          (value) => value !== undefined,
        );
        if (!changesFields && environment_id === undefined) {
          return fail(
            "変える項目がありません。name・status・progress_note・goal・environment_id のうち、変えるものだけを指定してください。",
          );
        }
        return Result.pipe(
          Result.do(),
          // 先に環境を確かめ、見つからなければ何も変えない
          Result.bind("environment", () =>
            environment_id === undefined ||
            environment_id === task.environmentId
              ? Result.succeed(undefined)
              : environmentOf(environment_id),
          ),
          Result.bind("updated", () =>
            changesFields
              ? createTaskToolHandlers(deps, task.id).updateTask(fields)
              : Result.succeed(undefined),
          ),
          Result.bind("moved", ({ environment }) =>
            environment === undefined
              ? Result.succeed(undefined)
              : Result.pipe(
                  tasks.setEnvironment(task.id, environment.id),
                  Result.andThen(() => environments.listEnvironments()),
                  Result.map((list) => {
                    const summary = list.find((e) => e.id === environment.id);
                    return summary !== undefined && summary.wikiName === null
                      ? `環境を「${environment.name}」に移しました。この環境は Wiki を使っていません。`
                      : `環境を「${environment.name}」に移しました。参照する Wiki は「${summary?.wikiName ?? "（不明）"}」になります。`;
                  }),
                ),
          ),
          Result.map(({ updated, moved, environment }) =>
            [
              updated,
              moved,
              environment_id !== undefined && environment === undefined
                ? "環境はすでに指定のものです。"
                : undefined,
            ]
              .filter((line) => line !== undefined)
              .join("\n"),
          ),
        );
      }),

    addLink: (input: {
      task_id?: string | undefined;
      url: string;
      label?: string | undefined;
    }): Result.Result<string, DesktopToolError> =>
      withTask(input.task_id, (task) =>
        createTaskToolHandlers(deps, task.id).addLink(input),
      ),

    updateLink: (input: {
      task_id?: string | undefined;
      id: string;
      url?: string | undefined;
      label?: string | undefined;
    }): Result.Result<string, DesktopToolError> =>
      withTask(input.task_id, (task) =>
        createTaskToolHandlers(deps, task.id).updateLink(input),
      ),

    listPages: (input: {
      task_id?: string | undefined;
    }): Result.Result<string, DesktopToolError> =>
      withTask(input.task_id, (task) => wikiHandlers(task.id).listPages()),

    readPage: (input: {
      task_id?: string | undefined;
      id: string;
    }): Result.Result<string, DesktopToolError> =>
      withTask(input.task_id, (task) => wikiHandlers(task.id).readPage(input)),

    createPage: (input: {
      task_id?: string | undefined;
      title: string;
      aliases?: string[] | undefined;
      body: string;
    }): Result.Result<string, DesktopToolError> =>
      withTask(input.task_id, (task) =>
        wikiHandlers(task.id).createPage(input),
      ),

    updatePage: (input: {
      task_id?: string | undefined;
      id: string;
      title?: string | undefined;
      aliases?: string[] | undefined;
      body?: string | undefined;
    }): Result.Result<string, DesktopToolError> =>
      withTask(input.task_id, (task) =>
        wikiHandlers(task.id).updatePage(input),
      ),

    editPage: (input: {
      task_id?: string | undefined;
      id: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean | undefined;
    }): Result.Result<string, DesktopToolError> =>
      withTask(input.task_id, (task) => wikiHandlers(task.id).editPage(input)),
  };
};

export type DesktopToolHandlers = ReturnType<typeof createDesktopToolHandlers>;
