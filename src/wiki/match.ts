/**
 * Wiki ページの照合（ローカルで行い、モデルは使わない）。
 */

export type WikiPageLike = {
  id: string;
  title: string;
  aliases: string[];
  body: string;
};

/** 関連ページとして選ぶ最大件数。 */
export const MAX_RELEVANT_PAGES = 3;

/** これより短い語（1 文字）は照合に使わない。 */
const MIN_TERM_LENGTH = 2;

const normalize = (value: string): string =>
  value.normalize("NFKC").toLowerCase().trim();

const isAscii = (value: string): boolean => /^[\x20-\x7e]+$/.test(value);

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 本文の見出し（# 〜 ###）。 */
export const headingsOf = (body: string): string[] =>
  body
    .split("\n")
    .flatMap((line) => /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line)?.[1] ?? []);

/**
 * text に term が含まれるか。英数字だけの語は単語の途中に一致させない（"AI" が "said" に一致しないように）。
 */
const contains = (text: string, term: string): boolean => {
  if (!isAscii(term)) {
    return text.includes(term);
  }
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}($|[^a-z0-9])`).test(
    text,
  );
};

/**
 * 質問に関係しそうなページを選ぶ。タイトル・別名・見出しが質問に含まれるページを、
 * タイトル > 別名 > 見出しの順、同じなら長い語に一致したものを優先して返す。
 */
export const selectRelevantPages = <P extends WikiPageLike>(
  pages: readonly P[],
  question: string,
  maxPages: number = MAX_RELEVANT_PAGES,
): P[] => {
  const text = normalize(question);
  if (text === "") {
    return [];
  }
  const scored = pages.flatMap((page) => {
    const terms = [
      ...[page.title].map((term) => ({ term, weight: 3 })),
      ...page.aliases.map((term) => ({ term, weight: 2 })),
      ...headingsOf(page.body).map((term) => ({ term, weight: 1 })),
    ];
    let best = 0;
    for (const { term, weight } of terms) {
      const normalized = normalize(term);
      if ([...normalized].length < MIN_TERM_LENGTH) continue;
      if (contains(text, normalized)) {
        best = Math.max(best, weight * 1000 + [...normalized].length);
      }
    }
    return best > 0 ? [{ page, score: best }] : [];
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPages)
    .map(({ page }) => page);
};

/** Wiki 画面の検索。タイトル・別名に一致したページを先に、本文に一致したページを後に並べる。 */
export const searchPages = <P extends WikiPageLike>(
  pages: readonly P[],
  query: string,
): P[] => {
  const q = normalize(query);
  if (q === "") {
    return [...pages];
  }
  const inName = (page: P) =>
    [page.title, ...page.aliases].some((term) => normalize(term).includes(q));
  return [
    ...pages.filter(inName),
    ...pages.filter(
      (page) => !inName(page) && normalize(page.body).includes(q),
    ),
  ];
};
