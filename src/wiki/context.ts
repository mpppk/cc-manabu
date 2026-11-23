import { Result } from "@praha/byethrow";
import type { WikiRepository } from "../db/wiki-repository.ts";
import { selectRelevantPages } from "./match.ts";
import { buildReferenceText } from "./reference.ts";

/** 1 ターン分の参照資料と、渡したページ（応答の metadata に残し、引用をリンクにする）。 */
export type WikiContext = {
  text: string;
  projectId: string;
  pages: { id: string; title: string }[];
};

export type WikiContextBuilder = (
  projectId: string,
  question: string,
) => WikiContext | undefined;

/**
 * 質問に関係するプロジェクトの Wiki ページを選び、参照資料にする。
 * 関係するページが無いとき、Wiki の読み込みに失敗したときは undefined（通常どおり生成する）。
 */
export const createWikiContextBuilder =
  (
    wiki: Pick<WikiRepository, "listPages">,
    onError: (error: unknown) => void = (error) =>
      console.warn("Wiki の参照資料を作れませんでした:", error),
  ): WikiContextBuilder =>
  (projectId, question) => {
    try {
      const pages = wiki.listPages(projectId);
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
            projectId,
            pages: reference.pages.map(({ id, title }) => ({ id, title })),
          };
    } catch (error) {
      onError(error);
      return undefined;
    }
  };
