import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./index.ts";
import {
  type ChatRow,
  type ChatStatus,
  chats,
  type MessageRow,
  messages,
} from "./schema.ts";

export class ChatNotFoundError extends ErrorFactory({
  name: "ChatNotFoundError",
  message: (fields) => `Chat not found: ${fields.chatId}`,
  fields: ErrorFactory.fields<{ chatId: string }>(),
}) {}

export class DatabaseError extends ErrorFactory({
  name: "DatabaseError",
  message: "A database error occurred",
}) {}

const run = <T>(fn: () => T): Result.Result<T, DatabaseError> =>
  Result.try({ try: fn, catch: (cause) => new DatabaseError({ cause }) });

const requireChat = (
  row: ChatRow | undefined,
  chatId: string,
): Result.Result<ChatRow, ChatNotFoundError> =>
  row === undefined
    ? Result.fail(new ChatNotFoundError({ chatId }))
    : Result.succeed(row);

export type NewMessage = {
  id: string;
  role: "user" | "assistant";
  parts: unknown[];
  metadata?: unknown;
  sdkUuid?: string | null;
};

export type ChatUpdate = Partial<
  Pick<ChatRow, "title" | "sessionId" | "model" | "effort" | "status">
>;

/** 会話とメッセージの永続化。すべて同期（bun:sqlite）で、失敗は Result で返す。 */
export const createChatRepository = (db: Db) => {
  const findChat = (chatId: string) =>
    run(() => db.select().from(chats).where(eq(chats.id, chatId)).get());

  return {
    createChat: (input: {
      cwd: string;
      projectId?: string | null;
      model?: string;
      effort?: string | null;
      title?: string;
      id?: string;
    }): Result.Result<ChatRow, DatabaseError> =>
      run(() => {
        const now = new Date();
        return db
          .insert(chats)
          .values({
            id: input.id ?? crypto.randomUUID(),
            projectId: input.projectId ?? null,
            cwd: input.cwd,
            model: input.model ?? "default",
            effort: input.effort ?? null,
            title: input.title ?? "",
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
      }),

    /** 更新日時の新しい順。 */
    listChats: (): Result.Result<ChatRow[], DatabaseError> =>
      run(() =>
        db
          .select()
          .from(chats)
          .orderBy(desc(chats.updatedAt), desc(chats.createdAt))
          .all(),
      ),

    getChat: (
      chatId: string,
    ): Result.Result<
      { chat: ChatRow; messages: MessageRow[] },
      ChatNotFoundError | DatabaseError
    > =>
      Result.pipe(
        findChat(chatId),
        Result.andThen((row) => requireChat(row, chatId)),
        Result.andThen((chat) =>
          Result.pipe(
            run(() =>
              db
                .select()
                .from(messages)
                .where(eq(messages.chatId, chatId))
                .orderBy(asc(messages.seq))
                .all(),
            ),
            Result.map((rows) => ({ chat, messages: rows })),
          ),
        ),
      ),

    updateChat: (
      chatId: string,
      update: ChatUpdate,
    ): Result.Result<ChatRow, ChatNotFoundError | DatabaseError> =>
      Result.pipe(
        run(() =>
          db
            .update(chats)
            .set({ ...update, updatedAt: new Date() })
            .where(eq(chats.id, chatId))
            .returning()
            .get(),
        ),
        Result.andThen((row) => requireChat(row, chatId)),
      ),

    /**
     * 会話の所属プロジェクトを変える（null で未所属）。
     * 一覧の並びが変わらないよう updatedAt は動かさない。
     */
    setProject: (
      chatId: string,
      projectId: string | null,
    ): Result.Result<ChatRow, ChatNotFoundError | DatabaseError> =>
      Result.pipe(
        run(() =>
          db
            .update(chats)
            .set({ projectId })
            .where(eq(chats.id, chatId))
            .returning()
            .get(),
        ),
        Result.andThen((row) => requireChat(row, chatId)),
      ),

    setStatus: (
      chatId: string,
      status: ChatStatus,
    ): Result.Result<void, DatabaseError> =>
      run(() => {
        // 状態の変化では updatedAt を動かさない（一覧の並びが変わらないように）
        db.update(chats).set({ status }).where(eq(chats.id, chatId)).run();
      }),

    deleteChat: (
      chatId: string,
    ): Result.Result<ChatRow, ChatNotFoundError | DatabaseError> =>
      Result.pipe(
        run(() =>
          db.delete(chats).where(eq(chats.id, chatId)).returning().get(),
        ),
        Result.andThen((row) => requireChat(row, chatId)),
      ),

    /**
     * メッセージを末尾に追加する。同じ id があれば内容を更新する（生成中の assistant メッセージの保存に使う）。
     */
    saveMessage: (
      chatId: string,
      message: NewMessage,
    ): Result.Result<MessageRow, DatabaseError> =>
      run(() =>
        db.transaction((tx) => {
          const existing = tx
            .select()
            .from(messages)
            .where(
              and(eq(messages.chatId, chatId), eq(messages.id, message.id)),
            )
            .get();
          const values = {
            parts: message.parts,
            metadata: message.metadata ?? null,
            sdkUuid: message.sdkUuid ?? null,
          };
          const saved =
            existing === undefined
              ? tx
                  .insert(messages)
                  .values({
                    id: message.id,
                    chatId,
                    role: message.role,
                    seq: sql`(SELECT COALESCE(MAX(${messages.seq}) + 1, 0) FROM ${messages} WHERE ${messages.chatId} = ${chatId})`,
                    ...values,
                  })
                  .returning()
                  .get()
              : tx
                  .update(messages)
                  .set(values)
                  .where(eq(messages.id, message.id))
                  .returning()
                  .get();
          tx.update(chats)
            .set({ updatedAt: new Date() })
            .where(eq(chats.id, chatId))
            .run();
          return saved;
        }),
      ),

    /** seq 以降のメッセージを消す（再生成・編集で使う）。消した件数を返す。 */
    deleteMessagesFrom: (
      chatId: string,
      seq: number,
    ): Result.Result<number, DatabaseError> =>
      run(
        () =>
          db
            .delete(messages)
            .where(and(eq(messages.chatId, chatId), gte(messages.seq, seq)))
            .returning({ id: messages.id })
            .all().length,
      ),
  };
};

export type ChatRepository = ReturnType<typeof createChatRepository>;
