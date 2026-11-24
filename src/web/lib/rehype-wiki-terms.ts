import type { ElementContent, Root, Text } from "hast";
import type { TermMatch } from "../../wiki/term-matcher.ts";
import { transformProse } from "./rehype-prose.ts";

/** 用語に結び付けた文字を包む要素の属性名（React では data-wiki-term）。 */
export const WIKI_TERM_ATTRIBUTE = "dataWikiTerm";

const splitText = (
  node: Text,
  match: (text: string) => TermMatch[],
): ElementContent[] | undefined => {
  const matches = match(node.value);
  if (matches.length === 0) {
    return undefined;
  }
  const parts: ElementContent[] = [];
  let cursor = 0;
  for (const { start, end, pageId } of matches) {
    if (start > cursor) {
      parts.push({ type: "text", value: node.value.slice(cursor, start) });
    }
    parts.push({
      type: "element",
      tagName: "span",
      properties: { [WIKI_TERM_ATTRIBUTE]: pageId },
      children: [{ type: "text", value: node.value.slice(start, end) }],
    });
    cursor = end;
  }
  if (cursor < node.value.length) {
    parts.push({ type: "text", value: node.value.slice(cursor) });
  }
  return parts;
};

/**
 * 回答本文の用語名・別名を `<span data-wiki-term="ページID">` で包む rehype プラグイン（#81）。
 * Markdown の安全化のあとに動かすので、属性は消されない。
 */
export const rehypeWikiTerms =
  (match: (text: string) => TermMatch[]) => () => (tree: Root) => {
    transformProse(tree, (node) => splitText(node, match));
  };
