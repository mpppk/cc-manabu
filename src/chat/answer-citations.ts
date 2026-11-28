/**
 * 回答（UIMessage）から出典を求める（#258）。回答の保存（サーバ）と、ストリーミング中の表示（Web UI）で同じ結果にする。
 */
import { WIKI_TOOL_NAMES } from "../wiki/tool-names.ts";
import {
  type AnswerCitations,
  buildCitations,
  type ToolCall,
} from "./citations.ts";

/** 出典を求めるのに使う、回答の部分。 */
export type CitableMessage = {
  parts: readonly {
    type: string;
    text?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    state?: string;
  }[];
  metadata?:
    | {
        wiki?: {
          taskId?: string;
          projectId?: string;
          pages: readonly { id: string; title: string }[];
        };
      }
    | undefined;
};

/** Wiki のノートを読むツールの結果から、ノートの ID とタイトルを読む。 */
const readPageOf = (
  call: ToolCall,
): { id: string; title: string } | undefined => {
  if (call.toolName !== WIKI_TOOL_NAMES.readPage) return undefined;
  const id = (call.input as { id?: unknown } | null)?.id;
  if (typeof id !== "string") return undefined;
  const text =
    typeof call.output === "string" ? call.output : JSON.stringify(call.output);
  const title = /タイトル: ([^\n"\\]+)/.exec(text ?? "")?.[1]?.trim();
  return { id, title: title ?? "ノート" };
};

/**
 * 回答の出典。参照資料として渡したノートと、Claude が読んだノート・ツールの結果にあるものだけを出典にする。
 * taskId は会話の所属タスク（参照資料を渡さなかった回答でも、読んだノートを開けるように）。
 */
export const citationsOfMessage = (
  message: CitableMessage,
  taskId?: string | null,
): AnswerCitations => {
  const calls: ToolCall[] = message.parts.flatMap((part) =>
    part.type === "dynamic-tool" &&
    part.state === "output-available" &&
    part.toolName !== undefined
      ? [{ toolName: part.toolName, input: part.input, output: part.output }]
      : [],
  );
  const wiki = message.metadata?.wiki;
  const wikiPages = new Map(
    (wiki?.pages ?? []).map((page) => [page.id, page.title] as const),
  );
  for (const call of calls) {
    const page = readPageOf(call);
    if (page !== undefined && !wikiPages.has(page.id)) {
      wikiPages.set(page.id, page.title);
    }
  }
  return buildCitations({
    text: message.parts
      .flatMap((part) =>
        part.type === "text" && part.text !== undefined ? [part.text] : [],
      )
      .join("\n\n"),
    calls,
    wikiTaskId: wiki?.taskId ?? wiki?.projectId ?? taskId ?? undefined,
    wikiPages,
  });
};
