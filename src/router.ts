import { os } from "@orpc/server";
import * as z from "zod";
import type { ChatRepository } from "./db/chat-repository.ts";
import type { ChatRow, MessageRow } from "./db/schema.ts";
import { type OrpcErrorCodeMap, unwrapForOrpc } from "./errors/index.ts";
import { version } from "./version.ts";

/** oRPC ハンドラに渡すコンテキスト。 */
export type RouterContext = {
  chats: ChatRepository;
  /** 新しい会話の作業ディレクトリ（起動時のカレントディレクトリ）。 */
  cwd: string;
};

export const base = os.$context<RouterContext>();

const ERROR_CODES: OrpcErrorCodeMap = { ChatNotFoundError: "NOT_FOUND" };

/** クライアントに返す会話。 */
export type ChatDto = Pick<
  ChatRow,
  | "id"
  | "title"
  | "model"
  | "effort"
  | "cwd"
  | "status"
  | "createdAt"
  | "updatedAt"
> & { hasSession: boolean };

/** クライアントに返すメッセージ（UIMessage の形）。 */
export type MessageDto = {
  id: string;
  role: MessageRow["role"];
  parts: unknown[];
  metadata: unknown;
};

const toChatDto = (row: ChatRow): ChatDto => ({
  id: row.id,
  title: row.title,
  model: row.model,
  effort: row.effort,
  cwd: row.cwd,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  hasSession: row.sessionId !== null,
});

const toMessageDto = (row: MessageRow): MessageDto => ({
  id: row.id,
  role: row.role,
  parts: row.parts,
  metadata: row.metadata ?? undefined,
});

const chatId = z.object({ id: z.string().min(1) });

export const router = {
  system: {
    /** サーバが動いていて、トークンが正しいかを確かめる。 */
    ping: base.handler(() => ({ ok: true as const, version })),
  },
  chats: {
    list: base.handler(async ({ context }) =>
      (await unwrapForOrpc(context.chats.listChats(), ERROR_CODES)).map(
        toChatDto,
      ),
    ),
    get: base.input(chatId).handler(async ({ context, input }) => {
      const { chat, messages } = await unwrapForOrpc(
        context.chats.getChat(input.id),
        ERROR_CODES,
      );
      return { chat: toChatDto(chat), messages: messages.map(toMessageDto) };
    }),
    create: base
      .input(
        z.object({
          model: z.string().min(1).optional(),
          effort: z.string().min(1).nullable().optional(),
        }),
      )
      .handler(async ({ context, input }) =>
        toChatDto(
          await unwrapForOrpc(
            context.chats.createChat({
              cwd: context.cwd,
              model: input.model,
              effort: input.effort,
            }),
            ERROR_CODES,
          ),
        ),
      ),
    rename: base
      .input(chatId.extend({ title: z.string().trim().min(1).max(200) }))
      .handler(async ({ context, input }) =>
        toChatDto(
          await unwrapForOrpc(
            context.chats.updateChat(input.id, { title: input.title }),
            ERROR_CODES,
          ),
        ),
      ),
    delete: base.input(chatId).handler(async ({ context, input }) => {
      await unwrapForOrpc(context.chats.deleteChat(input.id), ERROR_CODES);
      return { id: input.id };
    }),
  },
};

export type Router = typeof router;
