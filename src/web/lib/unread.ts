/**
 * 新しい回答の印（#234）。開いていない間に回答し終えた会話を覚えておき、開いたら外す。
 *
 * 会話の一覧は定期的に読み直しているので、その間に「回答中 → 回答済み」に変わったことを見て判定する。
 * 更新日時との比較では、スレッドの名前を変えただけでも新しい回答に見えてしまうため使わない。
 * 画面を開いていない間に回答し終えた会話には付かない。
 */
import { useEffect, useRef, useState } from "react";
import type { ChatDto } from "../../router.ts";

const STORAGE_KEY = "monet.unreadChats";

type Status = ChatDto["status"];

const isActive = (status: Status): boolean =>
  status === "running" || status === "awaiting_approval";

/**
 * 一覧を読み直したときの、新しい回答の印。
 * 前回の状態で回答中だった会話が回答を終え、そのとき開いていなければ印を付ける。
 * 開いている会話と、無くなった会話からは外す。
 */
export const nextUnread = (
  unread: ReadonlySet<string>,
  previous: ReadonlyMap<string, Status>,
  chats: readonly Pick<ChatDto, "id" | "status">[],
  visible: ReadonlySet<string>,
): Set<string> => {
  const ids = new Set(chats.map((chat) => chat.id));
  const next = new Set(
    [...unread].filter((id) => ids.has(id) && !visible.has(id)),
  );
  for (const chat of chats) {
    const before = previous.get(chat.id);
    if (
      before !== undefined &&
      isActive(before) &&
      !isActive(chat.status) &&
      !visible.has(chat.id)
    ) {
      next.add(chat.id);
    }
  }
  return next;
};

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((id) => b.has(id));

/** 保存した印。保存していない・読めないときは空。 */
export const parseUnread = (value: string | null | undefined): Set<string> => {
  if (value == null || value === "") return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
};

const load = (): Set<string> => {
  try {
    return parseUnread(localStorage.getItem(STORAGE_KEY));
  } catch {
    return new Set();
  }
};

const save = (unread: ReadonlySet<string>) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...unread]));
  } catch {
    // 保存できなくても、開いている間は印を出せる
  }
};

/**
 * 新しい回答の印が付いた会話。visible は、いま開いている会話（メインとサイドチャット）。
 * 再読み込みしても残るよう、ブラウザに保存する。
 */
export const useUnreadChats = (
  chats: readonly ChatDto[],
  visible: readonly (string | undefined)[],
): ReadonlySet<string> => {
  const [unread, setUnread] = useState(load);
  const previous = useRef(new Map<string, Status>());
  const loaded = useRef(false);
  const visibleKey = visible.filter((id) => id !== undefined).join(",");

  useEffect(() => {
    // 最初に読み込むまでは一覧が空なので、無くなった会話として印を外さない
    if (!loaded.current && chats.length === 0) return;
    loaded.current = true;
    const shown = new Set(visibleKey === "" ? [] : visibleKey.split(","));
    // 更新関数は後で呼ばれるので、前回の状態はここで取っておく
    const before = previous.current;
    setUnread((current) => {
      const next = nextUnread(current, before, chats, shown);
      if (sameSet(current, next)) return current;
      save(next);
      return next;
    });
    previous.current = new Map(chats.map((chat) => [chat.id, chat.status]));
  }, [chats, visibleKey]);

  return unread;
};
