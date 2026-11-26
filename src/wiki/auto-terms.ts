import { Result } from "@praha/byethrow";
import type { WikiPageRow } from "../db/schema.ts";
import { type TaskRepository, wikiIdOf } from "../db/task-repository.ts";
import type { WikiRepository } from "../db/wiki-repository.ts";
import { buildTermExtractionPrompt, parseTermCandidates } from "./terms.ts";

/** タスクのスレッドで回答が最後まで終わったこと。 */
export type AnswerCompleted = {
  chatId: string;
  taskId: string;
  /** 回答（assistant メッセージ）の id。 */
  messageId: string;
  question: string;
  answer: string;
};

/**
 * 回答から用語ページを作る処理（#80）。回答の保存とは切り離して後から動かし、失敗しても例外を投げない。
 * 自動作成を止めたタスクでは何もしない（モデルも呼ばない）。
 */
export const createTermPageWriter =
  (deps: {
    tasks: Pick<TaskRepository, "getTask">;
    wiki: Pick<WikiRepository, "listPages" | "createTermPages">;
    /**
     * 回答したタスクが属する環境の説明（#160）。Wiki を共有していても、回答した環境のものを使う。
     * 読めなければ説明なしとして続ける。
     */
    descriptionOf?: (taskId: string) => string | undefined;
    /** 用語抽出のモデル呼び出し（プロンプトを受け取り、出力の文字列を返す）。 */
    extract: (prompt: string) => Promise<string>;
    onError?: (error: unknown) => void;
  }) =>
  async (event: AnswerCompleted): Promise<WikiPageRow[]> => {
    const onError =
      deps.onError ??
      ((error: unknown) =>
        console.warn("用語ページを自動作成できませんでした:", error));
    try {
      const task = deps.tasks.getTask(event.taskId);
      if (Result.isFailure(task)) {
        onError(task.error);
        return [];
      }
      if (!task.value.autoTerms || event.answer.trim() === "") {
        return [];
      }
      const pages = deps.wiki.listPages(wikiIdOf(task.value));
      if (Result.isFailure(pages)) {
        onError(pages.error);
        return [];
      }
      const existing = pages.value.flatMap((page) => [
        page.title,
        ...page.aliases,
      ]);
      const output = await deps.extract(
        buildTermExtractionPrompt({
          question: event.question,
          answer: event.answer,
          existing,
          description: deps.descriptionOf?.(event.taskId) ?? "",
        }),
      );
      const candidates = parseTermCandidates(output, {
        answer: event.answer,
        existing,
      });
      if (candidates.length === 0) {
        return [];
      }
      const created = deps.wiki.createTermPages(
        wikiIdOf(task.value),
        candidates,
        {
          chatId: event.chatId,
          messageId: event.messageId,
        },
      );
      if (Result.isFailure(created)) {
        onError(created.error);
        return [];
      }
      return created.value;
    } catch (error) {
      onError(error);
      return [];
    }
  };
