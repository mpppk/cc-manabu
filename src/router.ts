import { os } from "@orpc/server";
import type { ChatRepository } from "./db/chat-repository.ts";
import { version } from "./version.ts";

/** oRPC ハンドラに渡すコンテキスト。 */
export type RouterContext = {
  chats: ChatRepository;
};

export const base = os.$context<RouterContext>();

export const router = {
  system: {
    /** サーバが動いていて、トークンが正しいかを確かめる。 */
    ping: base.handler(() => ({ ok: true as const, version })),
  },
};

export type Router = typeof router;
