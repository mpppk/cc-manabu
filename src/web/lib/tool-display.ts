import { WIKI_TOOL_NAMES, wikiToolLabel } from "../../wiki/tool-names.ts";

/** 画面に出すツールの名前（Wiki のツールは日本語の名前にする）。 */
export const toolLabel = (toolName: string): string =>
  wikiToolLabel(toolName) ?? toolName;

/** ツールの入力から、カードの見出しに出す短い説明を作る。 */
export const summarizeToolInput = (
  toolName: string,
  input: unknown,
): string => {
  if (typeof input !== "object" || input === null) {
    return "";
  }
  const record = input as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value !== "") {
        return value;
      }
    }
    return "";
  };
  switch (toolName) {
    case "Bash":
      return pick("command");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return pick("file_path", "notebook_path");
    case "Grep":
    case "Glob":
      return pick("pattern");
    case "WebFetch":
      return pick("url");
    case "WebSearch":
      return pick("query");
    case "Task":
    case "Agent":
      return pick("description", "prompt");
    case WIKI_TOOL_NAMES.listPages:
      return "";
    case WIKI_TOOL_NAMES.readPage:
    case WIKI_TOOL_NAMES.editPage:
      return pick("id");
    case WIKI_TOOL_NAMES.createPage:
    case WIKI_TOOL_NAMES.updatePage:
      return pick("title", "id");
    default:
      return pick("description", "file_path", "command", "url", "query");
  }
};

export type DiffLine = { kind: "removed" | "added" | "context"; text: string };

/**
 * Edit ツールの old_string / new_string を簡易的な差分にする。
 * 共通の先頭・末尾の行は context、間を removed / added として並べる。
 */
export const simpleDiff = (before: string, after: string): DiffLine[] => {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return [
    ...a.slice(0, start).map((text) => ({ kind: "context" as const, text })),
    ...a.slice(start, endA).map((text) => ({ kind: "removed" as const, text })),
    ...b.slice(start, endB).map((text) => ({ kind: "added" as const, text })),
    ...a.slice(endA).map((text) => ({ kind: "context" as const, text })),
  ];
};

/** 長い出力を省略する。省略したかどうかも返す。 */
export const truncate = (
  text: string,
  max: number,
): { text: string; truncated: boolean } =>
  text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };

/** ツールの出力（JSON 値）を表示用の文字列にする。 */
export const outputToText = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output, null, 2);
