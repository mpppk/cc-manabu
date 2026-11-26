import type { ChatDto } from "../../router.ts";

/** サイドバーに 1 行で出すスレッド（会話のまとまり、#76）。 */
export type ChatGroup = {
  groupId: string;
  /** スレッドを開いたときに表示する会話（最後に開いた会話。無ければ元の会話）。 */
  primary: ChatDto;
  /** 会話（作った順）。 */
  branches: ChatDto[];
  /** 会話のどれかが生成中・承認待ち・エラーなら、その状態。 */
  status: ChatDto["status"];
};

/**
 * まだ何も送っていないスレッド（＋で作ったまま）。タイトルは最初の送信で付くので、
 * 名前もセッションもない元の会話を空とみなす。
 */
export const isBlankChat = (chat: ChatDto): boolean =>
  chat.title === "" &&
  !chat.hasSession &&
  chat.parentId === null &&
  chat.status === "idle";

/** 一覧に出すスレッド。空のスレッドは、開いているときだけ出す。 */
export const listedChats = (
  chats: readonly ChatDto[],
  openId: string | undefined,
): ChatDto[] =>
  chats.filter((chat) => !isBlankChat(chat) || chat.id === openId);

const STATUS_PRIORITY: ChatDto["status"][] = [
  "awaiting_approval",
  "running",
  "error",
  "idle",
];

const time = (value: Date | string | null): number =>
  value === null ? 0 : new Date(value).getTime();

/**
 * 会話をスレッドごとにまとめる。並びは、スレッドの中でいちばん新しく更新された会話の順
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

/** 会話の表示名。元の会話は「元の会話」、分岐した会話は最初の発言から作った名前。 */
export const branchLabel = (chat: ChatDto): string =>
  chat.parentId === null
    ? "元の会話"
    : chat.branchTitle === ""
      ? "名前のない会話"
      : chat.branchTitle;
