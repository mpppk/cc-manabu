import { describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import { openDatabase } from "../../src/db/index.ts";
import { createTaskRepository } from "../../src/db/task-repository.ts";
import {
  createTaskToolHandlers,
  TaskToolInputError,
} from "../../src/task/tools.ts";

const setup = () => {
  const opened = openDatabase(":memory:");
  if (Result.isFailure(opened)) throw opened.error;
  const tasks = createTaskRepository(opened.value.db);
  const create = (name: string) => {
    const task = tasks.createTask({ name, directories: ["/work"] });
    if (Result.isFailure(task)) throw task.error;
    return task.value;
  };
  const task = create("認可基盤");
  const other = create("監査ログ");
  return {
    tasks,
    task,
    other,
    handlers: createTaskToolHandlers({ tasks }, task.id),
  };
};

const unwrap = <T>(result: Result.Result<T, unknown>): T => {
  if (Result.isFailure(result)) throw result.error;
  return result.value;
};

const reason = (result: Result.Result<unknown, unknown>): string => {
  if (Result.isSuccess(result)) throw new Error("成功してしまった");
  expect(result.error).toBeInstanceOf(TaskToolInputError);
  return (result.error as TaskToolInputError).message;
};

describe("タスクのツール（#187）", () => {
  test("指定した項目だけを更新し、変更内容を返す", () => {
    const { tasks, task, handlers } = setup();
    unwrap(
      tasks.updateProgress(task.id, {
        progressNote: "設計を進めた",
        nextAction: "調査する",
      }),
    );
    const text = unwrap(
      handlers.updateTask({
        status: "in_progress",
        next_action: " API 仕様をレビューする ",
      }),
    );
    expect(text).toContain("状態: 未着手 → 進行中");
    expect(text).toContain("次にやること: 調査する → API 仕様をレビューする");
    expect(text).not.toContain("進捗メモ");
    const updated = unwrap(tasks.getTask(task.id));
    expect(updated).toMatchObject({
      name: "認可基盤",
      status: "in_progress",
      progressNote: "設計を進めた",
      nextAction: "API 仕様をレビューする",
    });

    expect(unwrap(handlers.updateTask({ name: " 認可基盤 v2 " }))).toContain(
      "タスク名: 認可基盤 → 認可基盤 v2",
    );
    expect(unwrap(tasks.getTask(task.id)).status).toBe("in_progress");
  });

  test("画面と同じ検証をかけ、変えずに理由を返す", () => {
    const { tasks, task, handlers } = setup();
    expect(reason(handlers.updateTask({}))).toContain("変える項目がありません");
    expect(reason(handlers.updateTask({ name: "  " }))).toContain("name:");
    expect(
      reason(handlers.updateTask({ next_action: "あ".repeat(501) })),
    ).toContain("進捗:");
    expect(unwrap(tasks.getTask(task.id))).toMatchObject({
      name: "認可基盤",
      nextAction: "",
    });
  });

  test("関連リンクを追加・編集し、一覧と id を読める", () => {
    const { tasks, task, handlers } = setup();
    expect(
      unwrap(
        handlers.addLink({
          url: " https://example.com/design ",
          label: "設計資料",
        }),
      ),
    ).toContain("表示名: 設計資料 / URL: https://example.com/design");
    const [link] = unwrap(tasks.listLinks(task.id));
    if (link === undefined) throw new Error("リンクが無い");
    expect(unwrap(handlers.getTask())).toContain(
      `- id: ${link.id} / 表示名: 設計資料 / URL: https://example.com/design`,
    );

    // 指定しなかった項目はそのまま。表示名を空にすると URL を表示する
    expect(
      unwrap(
        handlers.updateLink({ id: link.id, url: "https://example.com/v2" }),
      ),
    ).toContain("変更後: 表示名: 設計資料 / URL: https://example.com/v2");
    unwrap(handlers.updateLink({ id: link.id, label: "" }));
    expect(unwrap(tasks.listLinks(task.id))).toMatchObject([
      { id: link.id, url: "https://example.com/v2", label: null },
    ]);
  });

  test("不正な URL や、ほかのタスクのリンクは変えずに理由を返す", () => {
    const { tasks, task, other, handlers } = setup();
    expect(reason(handlers.addLink({ url: "javascript:alert(1)" }))).toContain(
      "http または https",
    );
    expect(unwrap(tasks.listLinks(task.id))).toEqual([]);

    const foreign = unwrap(
      tasks.createLink({
        taskId: other.id,
        url: "https://example.com/other",
        label: "別タスク",
      }),
    );
    expect(
      reason(
        handlers.updateLink({ id: foreign.id, url: "https://evil.example" }),
      ),
    ).toContain("このタスクにありません");
    expect(unwrap(tasks.listLinks(other.id))).toMatchObject([
      { url: "https://example.com/other", label: "別タスク" },
    ]);
    const [mine] = [
      unwrap(handlers.addLink({ url: "https://example.com/mine" })),
    ];
    expect(mine).toContain("URL: https://example.com/mine");
    const link = unwrap(tasks.listLinks(task.id))[0];
    expect(
      reason(handlers.updateLink({ id: link?.id ?? "", url: "ftp://x" })),
    ).toContain("http または https");
  });
});
