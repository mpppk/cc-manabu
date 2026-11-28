import type { ChatUIMessage } from "../../chat/chat-service.ts";
import type { ChatDto } from "../../router.ts";

/** 「ここから分岐」の起点になる回答（#242）。 */
export type BranchPoint = {
  messageId: string;
  /** 複数の回答をまとめて出すときの、どの回答か（見出し）。 */
  label: string;
  /** この回答から分岐した会話（#235）。 */
  forks: readonly ChatDto[];
  /** この回答から新しい分岐を作る。作れないときは undefined。 */
  onCreate: (() => void) | undefined;
  /** 回答の一部を引用して質問した会話があるか（本文に下線を引く。#239）。 */
  quoted: boolean;
};

/** 回答の本文の書き出し（「…」で括る）。本文が無ければ空。分岐の起点を示すのに使う（#242）。 */
export const snippetOf = (message: ChatUIMessage, max: number): string => {
  const text = message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return "";
  return `「${text.length > max ? `${text.slice(0, max)}…` : text}」`;
};

/**
 * 回答（閉じたターンの見出しでは、そのターンの回答すべて）の「ここから分岐」の起点（#242）。
 * 分岐できる回答（分岐元の位置が分かる回答）と、すでに分岐した会話のある回答を、回答ごとに分ける。
 * 既存の分岐の一覧と新しい分岐の起点は、それぞれの回答に対応させる。
 */
export const branchPointsOf = (
  messages: readonly ChatUIMessage[],
  options: {
    /** その回答から分岐した会話。 */
    forksOf: (messageId: string) => readonly ChatDto[];
    /** 引用して質問した会話のある回答。 */
    quoted: (messageId: string) => boolean;
    /** 新しい分岐を作り始める。作れないとき（生成中など）は undefined。 */
    onCreate: ((messageId: string) => void) | undefined;
  },
): BranchPoint[] =>
  messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({
      message,
      branchable: message.metadata?.claudeCode?.lastAssistantUuid !== undefined,
      forks: options.forksOf(message.id),
    }))
    .filter(({ branchable, forks }) => branchable || forks.length > 0)
    .map(({ message, branchable, forks }, index) => {
      const create = options.onCreate;
      return {
        messageId: message.id,
        label: `回答 ${index + 1}${snippetOf(message, 24)}`,
        forks,
        onCreate:
          create !== undefined && branchable
            ? () => create(message.id)
            : undefined,
        quoted: options.quoted(message.id),
      };
    });
