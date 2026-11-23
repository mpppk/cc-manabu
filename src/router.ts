import { eventIterator, os } from "@orpc/server";
import type { InferUIMessageChunk } from "ai";
import * as z from "zod";
import type { ApprovalBroker } from "./chat/approval-broker.ts";
import { checkImagePart, MAX_IMAGES_PER_MESSAGE } from "./chat/attachments.ts";
import type { ChatService, ChatUIMessage } from "./chat/chat-service.ts";
import type { ClaudeStatusHolder } from "./claude/status.ts";
import type { ChatRepository } from "./db/chat-repository.ts";
import type { ChatRow, MessageRow } from "./db/schema.ts";
import { type OrpcErrorCodeMap, unwrapForOrpc } from "./errors/index.ts";
import { version } from "./version.ts";

/** oRPC ハンドラに渡すコンテキスト。 */
export type RouterContext = {
  chats: ChatRepository;
  chatService: ChatService;
  approvals: ApprovalBroker;
  claude: ClaudeStatusHolder;
  /** 新しい会話の作業ディレクトリ（起動時のカレントディレクトリ）。 */
  cwd: string;
};

export const base = os.$context<RouterContext>();

const ERROR_CODES: OrpcErrorCodeMap = {
  ChatNotFoundError: "NOT_FOUND",
  ChatAlreadyRunningError: "CONFLICT",
  TooManyRunnersError: "TOO_MANY_REQUESTS",
  ApprovalNotFoundError: "NOT_FOUND",
  MessageNotFoundError: "NOT_FOUND",
  NothingToRegenerateError: "BAD_REQUEST",
};

/** クライアントに流すチャンク（承認要求の data パーツを含む）。 */
export type ChatChunk = InferUIMessageChunk<ChatUIMessage>;

const chunkIterator = eventIterator(z.custom<ChatChunk>());

/** ChatRunner は UIMessageChunk を扱う。ChatService が流すのは ChatChunk だけなので型を絞る。 */
const subscribe = (
  runner: { subscribe: (signal?: AbortSignal) => AsyncGenerator<unknown> },
  signal: AbortSignal | undefined,
) => runner.subscribe(signal) as AsyncGenerator<ChatChunk, void>;

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

const userMessage = z.object({
  id: z.string().min(1),
  role: z.literal("user"),
  parts: z
    .array(z.object({ type: z.string() }).passthrough())
    .min(1)
    .superRefine((parts, ctx) => {
      const hasText = parts.some(
        (part) =>
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.trim() !== "",
      );
      const files = parts.filter((part) => part.type === "file");
      if (!hasText && files.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "message must contain text or images",
        });
      }
      if (files.length > MAX_IMAGES_PER_MESSAGE) {
        ctx.addIssue({
          code: "custom",
          message: `画像は 1 つの発話に ${MAX_IMAGES_PER_MESSAGE} 枚まで添付できます。`,
        });
      }
      for (const file of files) {
        const problem = checkImagePart({
          mediaType: file.mediaType,
          url: file.url,
        });
        if (problem !== undefined) {
          ctx.addIssue({ code: "custom", message: problem });
        }
      }
    }),
});

export const router = {
  system: {
    /** サーバが動いていて、トークンが正しいかを確かめる。 */
    ping: base.handler(() => ({ ok: true as const, version })),
    /** Claude Code の状態（インストール・バージョン・アカウント種別・モデル一覧）。 */
    status: base.handler(({ context }) => ({
      version,
      cwd: context.cwd,
      claude: context.claude.get(),
    })),
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
      // 生成中なら止めてから消す
      context.chatService.stop(input.id);
      await unwrapForOrpc(context.chats.deleteChat(input.id), ERROR_CODES);
      return { id: input.id };
    }),
  },
  chat: {
    /**
     * ユーザー発話を保存して生成を始め、UIMessageChunk を流す。
     * 接続が切れても生成は続く（chat.reconnect で続きを受け取れる）。
     */
    send: base
      .input(
        z.object({
          chatId: z.string().min(1),
          message: userMessage,
          model: z.string().min(1).optional(),
          effort: z
            .enum(["low", "medium", "high", "xhigh", "max"])
            .nullable()
            .optional(),
        }),
      )
      .output(chunkIterator)
      .handler(async ({ context, input, signal }) => {
        // 失敗（存在しない会話・生成中など）は、ストリームを返す前に呼び出しのエラーにする
        const runner = await unwrapForOrpc(
          context.chatService.send({
            chatId: input.chatId,
            message: input.message as Parameters<
              ChatService["send"]
            >[0]["message"],
            model: input.model,
            effort: input.effort,
          }),
          ERROR_CODES,
        );
        return subscribe(runner, signal);
      }),
    /** 最後の応答を作り直す（直前のターンから fork する）。 */
    regenerate: base
      .input(z.object({ chatId: z.string().min(1) }))
      .output(chunkIterator)
      .handler(async ({ context, input, signal }) => {
        const runner = await unwrapForOrpc(
          context.chatService.regenerate(input.chatId),
          ERROR_CODES,
        );
        return subscribe(runner, signal);
      }),
    /** ユーザー発話を書き換えて、そこから生成し直す。以降のメッセージは消える。 */
    edit: base
      .input(
        z.object({
          chatId: z.string().min(1),
          messageId: z.string().min(1),
          text: z.string().trim().min(1),
        }),
      )
      .output(chunkIterator)
      .handler(async ({ context, input, signal }) => {
        const runner = await unwrapForOrpc(
          context.chatService.edit({
            chatId: input.chatId,
            messageId: input.messageId,
            parts: [{ type: "text", text: input.text }],
          }),
          ERROR_CODES,
        );
        return subscribe(runner, signal);
      }),
    /** 生成中なら最初から流し直す。生成中でなければすぐに終わる。 */
    reconnect: base
      .input(z.object({ chatId: z.string().min(1) }))
      .output(chunkIterator)
      .handler(async function* ({ context, input, signal }) {
        const runner = context.chatService.reconnect(input.chatId);
        if (runner !== undefined) {
          yield* subscribe(runner, signal);
        }
      }),
    /** 生成を止める。 */
    stop: base
      .input(z.object({ chatId: z.string().min(1) }))
      .handler(({ context, input }) => ({
        stopped: context.chatService.stop(input.chatId),
      })),
  },
  approvals: {
    /** ツール実行の承認要求に答える。 */
    respond: base
      .input(
        z.object({
          chatId: z.string().min(1),
          approvalId: z.string().min(1),
          behavior: z.enum(["allow", "deny"]),
          message: z.string().max(1000).optional(),
        }),
      )
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(context.approvals.respond(input), ERROR_CODES);
        return { ok: true as const };
      }),
  },
};

export type Router = typeof router;
