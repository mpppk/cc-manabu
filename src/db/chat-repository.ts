import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
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
        const id = input.id ?? crypto.randomUUID();
        return db
          .insert(chats)
          .values({
            id,
            // 新しい会話は、自分自身が会話（分岐のまとまり）になる
            groupId: id,
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
     * 分岐を作る（#76）。分岐元の seq ≤ upToSeq のメッセージを新しい id でコピーし、
     * 分岐元が後で編集・再生成されても分岐の履歴が残るようにする。
     * タイトル・プロジェクト・作業ディレクトリは会話で共有する。
     */
    createBranch: (input: {
      id: string;
      parent: ChatRow;
      forkMessageId: string;
      upToSeq: number;
      branchTitle: string;
      forkSessionId: string;
      forkFromUuid: string;
      model: string;
      effort: string | null;
    }): Result.Result<ChatRow, DatabaseError> =>
      run(() =>
        db.transaction((tx) => {
          const now = new Date();
          const inherited = tx
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.chatId, input.parent.id),
                lte(messages.seq, input.upToSeq),
              ),
            )
            .orderBy(asc(messages.seq))
            .all();
          const branch = tx
            .insert(chats)
            .values({
              id: input.id,
              groupId: input.parent.groupId,
              parentId: input.parent.id,
              forkMessageId: input.forkMessageId,
              inheritedCount: inherited.length,
              branchTitle: input.branchTitle,
              forkSessionId: input.forkSessionId,
              forkFromUuid: input.forkFromUuid,
              projectId: input.parent.projectId,
              title: input.parent.title,
              cwd: input.parent.cwd,
              model: input.model,
              effort: input.effort,
              lastSelectedAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
          inherited.forEach((message, seq) => {
            tx.insert(messages)
              .values({
                id: crypto.randomUUID(),
                chatId: branch.id,
                seq,
                role: message.role,
                parts: message.parts,
                metadata: message.metadata,
                sdkUuid: message.sdkUuid,
                createdAt: message.createdAt,
              })
              .run();
          });
          return branch;
        }),
      ),

    /** 会話（分岐のまとまり）の分岐。作った順。 */
    listGroup: (groupId: string): Result.Result<ChatRow[], DatabaseError> =>
      run(() =>
        db
          .select()
          .from(chats)
          .where(eq(chats.groupId, groupId))
          .orderBy(asc(chats.createdAt))
          .all(),
      ),

    /** 会話のタイトルを、すべての分岐で変える。 */
    setGroupTitle: (
      groupId: string,
      title: string,
    ): Result.Result<void, DatabaseError> =>
      run(() => {
        db.update(chats)
          .set({ title, updatedAt: new Date() })
          .where(eq(chats.groupId, groupId))
          .run();
      }),

    /** 会話の所属プロジェクトを、すべての分岐で変える（更新日時は動かさない）。 */
    setGroupProject: (
      groupId: string,
      projectId: string | null,
    ): Result.Result<void, DatabaseError> =>
      run(() => {
        db.update(chats)
          .set({ projectId })
          .where(eq(chats.groupId, groupId))
          .run();
      }),

    /** 会話をすべての分岐ごと消す。消した分岐の id を返す。 */
    deleteGroup: (groupId: string): Result.Result<string[], DatabaseError> =>
      run(() =>
        db
          .delete(chats)
          .where(eq(chats.groupId, groupId))
          .returning({ id: chats.id })
          .all()
          .map((row) => row.id),
      ),

    /** この分岐を開いたことを記録する（会話を開き直したときに表示する分岐）。 */
    markSelected: (chatId: string): Result.Result<void, DatabaseError> =>
      run(() => {
        db.update(chats)
          .set({ lastSelectedAt: new Date() })
          .where(eq(chats.id, chatId))
          .run();
      }),

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
