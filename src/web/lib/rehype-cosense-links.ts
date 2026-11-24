import type { ElementContent, Root, Text } from "hast";
import { transformProse } from "./rehype-prose.ts";

const splitLinks = ({ value }: Text): ElementContent[] | undefined => {
  const parts: ElementContent[] = [];
  let cursor = 0;
  for (const match of value.matchAll(/\[\/([\w-]+)\/([^[\]\r\n]+)\]/g)) {
    const [label, project, page] = match;
    if (
      page === undefined ||
      page.trim() === "" ||
      page === "." ||
      page === ".."
    )
      continue;

    if (match.index > cursor) {
      parts.push({ type: "text", value: value.slice(cursor, match.index) });
    }
    parts.push({
      type: "element",
      tagName: "a",
      properties: {
        href: `https://cosen.se/${project}/${encodeURIComponent(page.toWellFormed())}`,
        dataCosenseLink: true,
      },
      children: [{ type: "text", value: label }],
    });
    cursor = match.index + label.length;
  }
  if (cursor === 0) return undefined;
  if (cursor < value.length) {
    parts.push({ type: "text", value: value.slice(cursor) });
  }
  return parts;
};

/** Claude の回答内にある Cosense のプロジェクト間リンクを表示する（#128）。 */
export const rehypeCosenseLinks = () => (tree: Root) => {
  transformProse(tree, splitLinks);
};
