/**
 * 回答本文の Wiki 引用（`[タイトル](wiki:ページID)`）を扱う。
 * リンクにするのは、そのターンで参照資料として渡したページだけ。
 */
import { WIKI_LINK_PREFIX } from "./reference.ts";

/** 画面内リンクにした引用の href（Markdown のリンク安全化で消されない、ページ内のフラグメント）。 */
export const WIKI_HREF_PREFIX = "#wiki-";

const CITATION = /\[([^\]\n]+)\]\(\s*wiki:([^)\s]+)\s*\)/g;

/** 引用されたページ ID のうち、渡したページに含まれるもの（重複なし、出てきた順）。 */
export const citedPageIds = (
  text: string,
  allowed: ReadonlySet<string>,
): string[] => [
  ...new Set(
    [...text.matchAll(CITATION)]
      .map((match) => match[2] ?? "")
      .filter((id) => allowed.has(id)),
  ),
];

/**
 * 引用を画面内リンクに書き換える。渡していないページ ID の引用はリンクにせず、文字だけ残す。
 */
export const linkWikiCitations = (
  text: string,
  allowed: ReadonlySet<string>,
): string =>
  text.includes(WIKI_LINK_PREFIX)
    ? text.replace(CITATION, (_, label: string, id: string) =>
        allowed.has(id)
          ? `[${label}](${WIKI_HREF_PREFIX}${encodeURIComponent(id)})`
          : label,
      )
    : text;

/**
 * 画面内リンクの href からページ ID を取り出す。
 * Markdown の安全化でフラグメントに `user-content-` が付く（`#user-content-wiki-<id>`）ので、それも受け付ける。
 */
export const pageIdFromHref = (
  href: string | undefined,
): string | undefined => {
  const match = /^#(?:user-content-)?wiki-(.+)$/.exec(href ?? "");
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
};
