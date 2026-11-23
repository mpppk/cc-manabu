/**
 * 回答本文の中の用語名・別名を見つける（#81）。重なる一致では長い語を優先する。
 */

export type TermEntry = {
  pageId: string;
  /** タイトルと別名。 */
  names: string[];
};

export type TermMatch = { start: number; end: number; pageId: string };

const isAsciiWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[a-z0-9_]/i.test(char);

const isAscii = (value: string): boolean => /^[\x20-\x7e]+$/.test(value);

/** これより短い語（1 文字）は結び付けない。 */
const MIN_LENGTH = 2;

/**
 * 用語の一覧から、テキストの中の一致を探す関数を作る。
 * 大文字小文字は区別しない。英数字だけの語は単語の途中に一致させない。
 */
export const createTermMatcher = (
  entries: readonly TermEntry[],
): ((text: string) => TermMatch[]) => {
  const byFirstChar = new Map<
    string,
    { key: string; pageId: string; ascii: boolean }[]
  >();
  for (const entry of entries) {
    for (const name of entry.names) {
      const key = name.trim().toLowerCase();
      if ([...key].length < MIN_LENGTH) continue;
      const first = key[0] ?? "";
      const list = byFirstChar.get(first) ?? [];
      list.push({ key, pageId: entry.pageId, ascii: isAscii(key) });
      byFirstChar.set(first, list);
    }
  }
  for (const list of byFirstChar.values()) {
    list.sort((a, b) => b.key.length - a.key.length);
  }
  if (byFirstChar.size === 0) {
    return () => [];
  }

  return (text) => {
    // 小文字にして長さが変わる文字があるときは、元の文字列のまま照合する
    const lower = text.toLowerCase();
    const haystack = lower.length === text.length ? lower : text;
    const matches: TermMatch[] = [];
    let i = 0;
    while (i < haystack.length) {
      const candidates = byFirstChar.get(haystack[i] ?? "");
      const found = candidates?.find(
        ({ key, ascii }) =>
          haystack.startsWith(key, i) &&
          (!ascii ||
            (!isAsciiWordChar(haystack[i - 1]) &&
              !isAsciiWordChar(haystack[i + key.length]))),
      );
      if (found === undefined) {
        i++;
        continue;
      }
      matches.push({
        start: i,
        end: i + found.key.length,
        pageId: found.pageId,
      });
      i += found.key.length;
    }
    return matches;
  };
};
