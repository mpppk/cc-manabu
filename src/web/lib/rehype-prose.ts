import type { Element, ElementContent, Root, Text } from "hast";

/** Markdown のリンク・コード・数式などには本文の変換を適用しない。 */
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

const shouldSkip = (element: Element): boolean => {
  const value = element.properties.className;
  const names = Array.isArray(value)
    ? value.map(String)
    : String(value ?? "").split(/\s+/);
  return (
    SKIP_TAGS.has(element.tagName) ||
    names.some((name) => /katex|math/.test(name))
  );
};

export const transformProse = (
  parent: Root | Element,
  transform: (node: Text) => ElementContent[] | undefined,
): void => {
  const children: Root["children"] = [];
  for (const child of parent.children) {
    if (child.type === "text") {
      children.push(...(transform(child) ?? [child]));
      continue;
    }
    if (child.type === "element" && !shouldSkip(child)) {
      transformProse(child, transform);
    }
    children.push(child);
  }
  parent.children = children as typeof parent.children;
};
