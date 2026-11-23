import type { ChatDto } from "../../router.ts";

/** サイドバーに 1 行で出す会話（分岐のまとまり、#76）。 */
export type ChatGroup = {
  groupId: string;
  /** 会話を開いたときに表示する分岐（最後に開いた分岐。無ければ元の会話）。 */
  primary: ChatDto;
  /** 分岐（作った順）。 */
  branches: ChatDto[];
  /** 分岐のどれかが生成中・承認待ち・エラーなら、その状態。 */
  status: ChatDto["status"];
};

const STATUS_PRIORITY: ChatDto["status"][] = [
  "awaiting_approval",
  "running",
  "error",
  "idle",
];

const time = (value: Date | string | null): number =>
  value === null ? 0 : new Date(value).getTime();

/**
 * 分岐を会話ごとにまとめる。並びは、会話の中でいちばん新しく更新された分岐の順
 * （chats.list は更新日時の新しい順なので、最初に出てきた順）。
 */
export const groupChats = (chats: readonly ChatDto[]): ChatGroup[] => {
  const groups = new Map<string, ChatDto[]>();
  for (const chat of chats) {
    const key = chat.groupId === "" ? chat.id : chat.groupId;
    groups.set(key, [...(groups.get(key) ?? []), chat]);
  }
  return [...groups.entries()].map(([groupId, members]) => {
    const branches = [...members].sort(
      (a, b) => time(a.createdAt) - time(b.createdAt),
    );
    const root = branches.find((chat) => chat.id === groupId) ?? branches[0];
    const primary = branches.reduce<ChatDto | undefined>(
      (best, chat) =>
        best === undefined ||
        time(chat.lastSelectedAt) > time(best.lastSelectedAt)
          ? chat
          : best,
      undefined,
    );
    const status =
      STATUS_PRIORITY.find((s) => branches.some((chat) => chat.status === s)) ??
      "idle";
    return {
      groupId,
      primary:
        primary !== undefined && primary.lastSelectedAt !== null
          ? primary
          : (root as ChatDto),
      branches,
      status,
    };
  });
};

/** 分岐の表示名。元の会話は「元の会話」、分岐は最初の発言から作った名前。 */
export const branchLabel = (chat: ChatDto): string =>
  chat.parentId === null
    ? "元の会話"
    : chat.branchTitle === ""
      ? "分岐"
      : chat.branchTitle;
