import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";
import {
  chats,
  messages,
  type QueuedMessageRow,
  type QueueStatus,
  queuedMessages,
} from "./schema.ts";

export class QueuedMessageNotFoundError extends ErrorFactory({
  name: "QueuedMessageNotFoundError",
  message: (fields) => `Queued message not found: ${fields.id}`,
  fields: ErrorFactory.fields<{ id: string }>(),
}) {}

const run = <T>(fn: () => T): Result.Result<T, DatabaseError> =>
  Result.try({ try: fn, catch: (cause) => new DatabaseError({ cause }) });

const requireItem = (
  row: QueuedMessageRow | undefined,
  id: string,
): Result.Result<QueuedMessageRow, QueuedMessageNotFoundError> =>
  row === undefined
    ? Result.fail(new QueuedMessageNotFoundError({ id }))
    : Result.succeed(row);

/** 予約したメッセージ（#102）の永続化。 */
export const createQueueRepository = (db: Db) => ({
  /** 分岐の予約（送る順）。 */
  list: (chatId: string): Result.Result<QueuedMessageRow[], DatabaseError> =>
    run(() =>
      db
        .select()
        .from(queuedMessages)
        .where(eq(queuedMessages.chatId, chatId))
        .orderBy(asc(queuedMessages.position))
        .all(),
    ),

  get: (
    id: string,
  ): Result.Result<
    QueuedMessageRow,
    QueuedMessageNotFoundError | DatabaseError
  > =>
    Result.pipe(
      run(() =>
        db.select().from(queuedMessages).where(eq(queuedMessages.id, id)).get(),
      ),
      Result.andThen((row) => requireItem(row, id)),
    ),

  /** 末尾に追加する。 */
  add: (input: {
    id: string;
    chatId: string;
    parts: unknown[];
  }): Result.Result<QueuedMessageRow, DatabaseError> =>
    run(() => {
      const now = new Date();
      return db
        .insert(queuedMessages)
        .values({
          id: input.id,
          chatId: input.chatId,
          parts: input.parts,
          position: sql`(SELECT COALESCE(MAX(${queuedMessages.position}) + 1, 0) FROM ${queuedMessages} WHERE ${queuedMessages.chatId} = ${input.chatId})`,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    }),

  /** 本文などを書き換える（送信待ち・保留のものだけ）。 */
  updateParts: (
    id: string,
    parts: unknown[],
  ): Result.Result<
    QueuedMessageRow,
    QueuedMessageNotFoundError | DatabaseError
  > =>
    Result.pipe(
      run(() =>
        db
          .update(queuedMessages)
          .set({ parts, updatedAt: new Date() })
          .where(
            and(
              eq(queuedMessages.id, id),
              inArray(queuedMessages.status, ["pending", "held"]),
            ),
          )
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireItem(row, id)),
    ),

  setStatus: (
    id: string,
    status: QueueStatus,
  ): Result.Result<void, DatabaseError> =>
    run(() => {
      db.update(queuedMessages)
        .set({ status, updatedAt: new Date() })
        .where(eq(queuedMessages.id, id))
        .run();
    }),

  remove: (
    id: string,
  ): Result.Result<
    QueuedMessageRow,
    QueuedMessageNotFoundError | DatabaseError
  > =>
    Result.pipe(
      run(() =>
        db
          .delete(queuedMessages)
          .where(eq(queuedMessages.id, id))
          .returning()
          .get(),
      ),
      Result.andThen((row) => requireItem(row, id)),
    ),

  /** 予約の送信を止める・再開する。 */
  setPaused: (
    chatId: string,
    paused: boolean,
  ): Result.Result<void, DatabaseError> =>
    run(() => {
      db.update(chats)
        .set({ queuePaused: paused })
        .where(eq(chats.id, chatId))
        .run();
    }),

  isPaused: (chatId: string): Result.Result<boolean, DatabaseError> =>
    run(
      () =>
        db
          .select({ paused: chats.queuePaused })
          .from(chats)
          .where(eq(chats.id, chatId))
          .get()?.paused ?? false,
    ),

  /** 送信待ちの予約がある分岐。 */
  chatsWithPending: (): Result.Result<string[], DatabaseError> =>
    run(() =>
      db
        .selectDistinct({ chatId: queuedMessages.chatId })
        .from(queuedMessages)
        .where(eq(queuedMessages.status, "pending"))
        .all()
        .map((row) => row.chatId),
    ),

  /** その id の発話がもう保存されているか（送信済みか）。 */
  isSent: (chatId: string, id: string): Result.Result<boolean, DatabaseError> =>
    run(
      () =>
        db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.chatId, chatId), eq(messages.id, id)))
          .get() !== undefined,
    ),

  /**
   * サーバ起動時の復元。送信中だった予約は、発話が保存されていれば送信済みとして消し、
   * そうでなければ保留にする（送ったか分からないので利用者に確かめてもらう）。
   * 予約が残っている分岐は、勝手に送らないよう一時停止にする。
   */
  recover: (): Result.Result<void, DatabaseError> =>
    run(() =>
      db.transaction((tx) => {
        const sending = tx
          .select()
          .from(queuedMessages)
          .where(eq(queuedMessages.status, "sending"))
          .all();
        for (const item of sending) {
          const sent =
            tx
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(eq(messages.chatId, item.chatId), eq(messages.id, item.id)),
              )
              .get() !== undefined;
          if (sent) {
            tx.delete(queuedMessages)
              .where(eq(queuedMessages.id, item.id))
              .run();
          } else {
            tx.update(queuedMessages)
              .set({ status: "held", updatedAt: new Date() })
              .where(eq(queuedMessages.id, item.id))
              .run();
          }
        }
        const remaining = tx
          .selectDistinct({ chatId: queuedMessages.chatId })
          .from(queuedMessages)
          .all()
          .map((row) => row.chatId);
        if (remaining.length > 0) {
          tx.update(chats)
            .set({ queuePaused: true })
            .where(inArray(chats.id, remaining))
            .run();
        }
      }),
    ),
});

export type QueueRepository = ReturnType<typeof createQueueRepository>;
