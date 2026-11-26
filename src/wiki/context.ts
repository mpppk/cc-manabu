import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import type { DatabaseError } from "../db/chat-repository.ts";
import type { WikiPageRow } from "../db/schema.ts";
import {
  TaskNotFoundError,
  type TaskRepository,
  wikiIdOf,
} from "../db/task-repository.ts";
import {
  WikiPageNotFoundError,
  type WikiRepository,
} from "../db/wiki-repository.ts";
import { selectRelevantPages } from "./match.ts";
import { buildReferenceText } from "./reference.ts";

/** 1 ターン分の参照資料と、渡したページ（回答の metadata に残し、引用をリンクにする）。 */
export type WikiContext = {
  text: string;
  taskId: string;
  pages: { id: string; title: string }[];
  excerpted?: boolean;
};

export type WikiContextBuilder = (
  taskId: string,
  question: string,
) => WikiContext | undefined;

/**
 * 質問に関係する、タスクが参照する Wiki のページを選び、参照資料にする。
 * 関係するページが無いとき、Wiki の読み込みに失敗したときは undefined（通常どおり生成する）。
 */
export const createWikiContextBuilder =
  (
    wiki: Pick<WikiRepository, "listPages">,
    tasks: Pick<TaskRepository, "getTask">,
    onError: (error: unknown) => void = (error) =>
      console.warn("Wiki の参照資料を作れませんでした:", error),
  ): WikiContextBuilder =>
  (taskId, question) => {
    try {
      const task = tasks.getTask(taskId);
      if (Result.isFailure(task)) {
        onError(task.error);
        return undefined;
      }
      const pages = wiki.listPages(wikiIdOf(task.value));
      if (Result.isFailure(pages)) {
        onError(pages.error);
        return undefined;
      }
      const reference = buildReferenceText(
        selectRelevantPages(pages.value, question),
      );
      return reference === undefined
        ? undefined
        : {
            text: reference.text,
            taskId,
            pages: reference.pages.map(({ id, title }) => ({ id, title })),
          };
    } catch (error) {
      onError(error);
      return undefined;
    }
  };

export class WikiPageUnavailableError extends ErrorFactory({
  name: "WikiPageUnavailableError",
  message:
    "この Wiki ページを参照できません。削除されたか、このタスクの Wiki に属していません。",
}) {}

export type WikiPageReader = (
  taskId: string,
  pageId: string,
) => Result.Result<WikiPageRow, DatabaseError | WikiPageUnavailableError>;

/** 明示的な参照は、送信時点でページがタスクの Wiki に属するときだけ許可する。 */
export const createWikiPageReader =
  (
    wiki: Pick<WikiRepository, "getPage">,
    tasks: Pick<TaskRepository, "getTask">,
  ): WikiPageReader =>
  (taskId, pageId) =>
    Result.pipe(
      tasks.getTask(taskId),
      Result.andThen((task) =>
        Result.pipe(
          wiki.getPage(pageId),
          Result.andThen((page) =>
            page.wikiId === wikiIdOf(task)
              ? Result.succeed(page)
              : Result.fail(new WikiPageUnavailableError()),
          ),
        ),
      ),
      Result.mapError((error) =>
        error instanceof WikiPageNotFoundError ||
        error instanceof TaskNotFoundError
          ? new WikiPageUnavailableError({ cause: error })
          : error,
      ),
    );

export const wikiPageContext = (
  taskId: string,
  page: WikiPageRow,
  question: string,
): WikiContext | undefined => {
  const reference = buildReferenceText([page], question);
  if (reference === undefined) return undefined;
  return {
    text: reference.text,
    taskId,
    pages: [{ id: page.id, title: page.title }],
    ...(reference.excerpted ? { excerpted: true } : {}),
  };
};
