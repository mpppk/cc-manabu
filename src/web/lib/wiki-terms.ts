import { useMemo } from "react";
import type { WikiPageDto } from "../../router.ts";
import { createTermMatcher, type TermMatch } from "../../wiki/term-matcher.ts";

/**
 * ノートの本文から用語を照合する関数（#210）。同じ Wiki の別のノートのタイトル・別名と照合し、
 * 閲覧中のノート自身（excludePageId）へのリンクは作らない。照合するノートが無ければ undefined。
 * タイトル・別名が変わらない限り同じ関数を返す（本文の描き直しを避ける）。
 */
export const useNoteTermMatcher = (
  pages: readonly WikiPageDto[] | undefined,
  excludePageId: string,
): ((text: string) => TermMatch[]) | undefined => {
  const key = JSON.stringify(
    (pages ?? [])
      .filter((page) => page.id !== excludePageId)
      .map((page) => [page.id, page.title, ...page.aliases]),
  );
  return useMemo(() => {
    const entries = (JSON.parse(key) as string[][]).map(
      ([pageId = "", ...names]) => ({ pageId, names }),
    );
    return entries.length === 0 ? undefined : createTermMatcher(entries);
  }, [key]);
};
