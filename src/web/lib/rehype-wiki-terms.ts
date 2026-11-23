import type { Element, ElementContent, Root, Text } from "hast";
import type { TermMatch } from "../../wiki/term-matcher.ts";

/** 用語に結び付けた文字を包む要素の属性名（React では data-wiki-term）。 */
export const WIKI_TERM_ATTRIBUTE = "dataWikiTerm";

/** この中の文字は用語に結び付けない（コード・リンク・ボタン・数式など）。 */
const SKIP_TAGS = new Set([
  "a",
  "button",
  "code",
  "pre",
  "kbd",
  "samp",
  "script",
  "style",
  "svg",
  "math",
]);

const classNamesOf = (element: Element): string[] => {
  const value: unknown = element.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? value.split(/\s+/) : [];
};

const shouldSkip = (element: Element): boolean =>
  SKIP_TAGS.has(element.tagName) ||
  classNamesOf(element).some((name) => /katex|math/.test(name));

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

const visit = (
  parent: Root | Element,
  match: (text: string) => TermMatch[],
): void => {
  const children: (typeof parent.children)[number][] = [];
  for (const child of parent.children) {
    if (child.type === "text") {
      const split = splitText(child, match);
      if (split !== undefined) {
        children.push(...split);
        continue;
      }
    } else if (child.type === "element" && !shouldSkip(child)) {
      visit(child, match);
    }
    children.push(child);
  }
  parent.children = children as typeof parent.children;
};

/**
 * 回答本文の用語名・別名を `<span data-wiki-term="ページID">` で包む rehype プラグイン（#81）。
 * Markdown の安全化のあとに動かすので、属性は消されない。
 */
export const rehypeWikiTerms =
  (match: (text: string) => TermMatch[]) => () => (tree: Root) => {
    visit(tree, match);
  };
