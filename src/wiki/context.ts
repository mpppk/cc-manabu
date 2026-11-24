import { Result } from "@praha/byethrow";
import { type TaskRepository, wikiIdOf } from "../db/task-repository.ts";
import type { WikiRepository } from "../db/wiki-repository.ts";
import { selectRelevantPages } from "./match.ts";
import { buildReferenceText } from "./reference.ts";

/** 1 ターン分の参照資料と、渡したページ（応答の metadata に残し、引用をリンクにする）。 */
export type WikiContext = {
  text: string;
  taskId: string;
  pages: { id: string; title: string }[];
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
