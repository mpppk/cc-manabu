import { Result } from "@praha/byethrow";
import { type ProjectRepository, wikiIdOf } from "../db/project-repository.ts";
import type { WikiPageRow } from "../db/schema.ts";
import type { WikiRepository } from "../db/wiki-repository.ts";
import { buildTermExtractionPrompt, parseTermCandidates } from "./terms.ts";

/** プロジェクトのスレッドで回答が最後まで終わったこと。 */
export type AnswerCompleted = {
  chatId: string;
  projectId: string;
  /** 回答（assistant メッセージ）の id。 */
  messageId: string;
  question: string;
  answer: string;
};

/**
 * 回答から用語ページを作る処理（#80）。回答の保存とは切り離して後から動かし、失敗しても例外を投げない。
 * 自動作成を止めたプロジェクトでは何もしない（モデルも呼ばない）。
 */
export const createTermPageWriter =
  (deps: {
    projects: Pick<ProjectRepository, "getProject">;
    wiki: Pick<WikiRepository, "listPages" | "createTermPages">;
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
      const project = deps.projects.getProject(event.projectId);
      if (Result.isFailure(project)) {
        onError(project.error);
        return [];
      }
      if (!project.value.autoTerms || event.answer.trim() === "") {
        return [];
      }
      const pages = deps.wiki.listPages(wikiIdOf(project.value));
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
        wikiIdOf(project.value),
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
