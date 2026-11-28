import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import {
  type AnswerQuote,
  isWikiPageQuote,
  type QuoteRange,
  quotesOf,
} from "../chat/quote.ts";
import type { Db } from "./index.ts";
import {
  type AgentId,
  type ChatRow,
  type ChatStatus,
  type ContextUsage,
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

export class WikiChatTaskError extends ErrorFactory({
  name: "WikiChatTaskError",
  message: "Wiki ページの会話は別のタスクに移動できません。",
}) {}

/** 会話の中の分岐点（#235）と、そこから回答を引用して分岐した会話の引用（#239）。 */
export type ForkPoint = {
  /** 分岐点の回答（この会話のメッセージ）の id。 */
  messageId: string;
  /** この回答から分岐した会話（作った順）。 */
  chatIds: string[];
  /**
   * そのうち、回答の一部を引用して質問した会話と、その引用。
   * question はその会話で最初に送った質問の本文（紫の破線のプレビューに出す。#266）。
   */
  quotes: {
    chatId: string;
    text: string;
    range?: QuoteRange;
    question: string;
  }[];
};

/** 質問の本文（テキストのパートだけをつなぐ。引用や画像は含めない）。 */
const questionTextOf = (parts: readonly unknown[]): string =>
  parts
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n")
    .trim();

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
  Pick<ChatRow, "title" | "sessionId" | "model" | "effort" | "status" | "agent">
>;

/** 会話とメッセージの永続化。すべて同期（bun:sqlite）で、失敗は Result で返す。 */
export const createChatRepository = (db: Db) => {
  const findChat = (chatId: string) =>
    run(() => db.select().from(chats).where(eq(chats.id, chatId)).get());

  const wikiChatWhere = (taskId: string, pageId: string) =>
    and(
      eq(chats.taskId, taskId),
      eq(chats.wikiPageId, pageId),
      isNull(chats.parentId),
    );

  const newChatValues = (input: {
    cwd: string;
    taskId?: string | null;
    wikiPageId?: string;
    model?: string;
    effort?: string | null;
    title?: string;
    id?: string;
    agent?: AgentId;
  }) => {
    const now = new Date();
    const id = input.id ?? crypto.randomUUID();
    return {
      id,
      groupId: id,
      taskId: input.taskId ?? null,
      wikiPageId: input.wikiPageId ?? null,
      cwd: input.cwd,
      model: input.model ?? "default",
      effort: input.effort ?? null,
      title: input.title ?? "",
      agent: input.agent ?? "claude-code",
      createdAt: now,
      updatedAt: now,
    };
  };

  return {
    createChat: (
      input: Omit<Parameters<typeof newChatValues>[0], "wikiPageId">,
    ): Result.Result<ChatRow, DatabaseError> =>
      run(() =>
        db.insert(chats).values(newChatValues(input)).returning().get(),
      ),

    getWikiChat: (taskId: string, pageId: string) =>
      run(() =>
        db.select().from(chats).where(wikiChatWhere(taskId, pageId)).get(),
      ),

    /** 複数のタブで初回送信しても、同じタスクとページの会話は 1 つにする。 */
    getOrCreateWikiChat: (input: {
      id: string;
      taskId: string;
      wikiPageId: string;
      title: string;
      cwd: string;
    }): Result.Result<ChatRow, DatabaseError> =>
      run(() =>
        db.transaction(
          (tx) =>
            tx
              .select()
              .from(chats)
              .where(wikiChatWhere(input.taskId, input.wikiPageId))
              .get() ??
            tx.insert(chats).values(newChatValues(input)).returning().get(),
          { behavior: "immediate" },
        ),
      ),

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
     * 分岐した会話を作る（#76）。分岐元の seq ≤ upToSeq のメッセージを新しい id でコピーし、
     * 分岐元が後で編集・再生成されても新しい会話の履歴が残るようにする。
     * タイトル・タスク・作業ディレクトリはスレッドで共有する。
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
      selectBranch: boolean;
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
              taskId: input.parent.taskId,
              // アーカイブしたスレッドで分岐しても、スレッドの状態をそろえる（#256）
              archivedAt: input.parent.archivedAt,
              wikiPageId: input.parent.wikiPageId,
              title: input.parent.title,
              cwd: input.parent.cwd,
              // 分岐した会話も、分岐元と同じ AI で続ける（#265）
              agent: input.parent.agent,
              model: input.model,
              effort: input.effort,
              lastSelectedAt: input.selectBranch ? now : null,
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

    /** スレッド（会話のまとまり）の会話。作った順。 */
    listGroup: (groupId: string): Result.Result<ChatRow[], DatabaseError> =>
      run(() =>
        db
          .select()
          .from(chats)
          .where(eq(chats.groupId, groupId))
          .orderBy(asc(chats.createdAt))
          .all(),
      ),

    /** スレッドのタイトルを、すべての会話で変える。 */
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

    /**
     * スレッドのタイトルが expected のままなら title に変える（自動で付けるタイトル用）。
     * 利用者がその間に名前を変えていれば変えずに false を返す。更新日時は動かさない。
     */
    setGroupTitleIf: (
      groupId: string,
      expected: string,
      title: string,
    ): Result.Result<boolean, DatabaseError> =>
      run(
        () =>
          db
            .update(chats)
            .set({ title })
            .where(and(eq(chats.groupId, groupId), eq(chats.title, expected)))
            .returning({ id: chats.id })
            .all().length > 0,
      ),

    /** スレッドの所属タスクを、すべての会話で変える（更新日時は動かさない）。 */
    setGroupTask: (
      groupId: string,
      taskId: string | null,
    ): Result.Result<void, DatabaseError> =>
      run(() => {
        db.update(chats)
          .set({ taskId })
          .where(eq(chats.groupId, groupId))
          .run();
      }),

    /**
     * スレッドをアーカイブする・復元する（#256）。スレッドのすべての会話に同じ日時を付け外しする。
     * 所属・履歴・分岐は変えない。一覧の並び（更新日時）も変えない。
     */
    setGroupArchived: (
      groupId: string,
      archived: boolean,
    ): Result.Result<void, DatabaseError> =>
      run(() => {
        db.update(chats)
          .set({ archivedAt: archived ? new Date() : null })
          .where(eq(chats.groupId, groupId))
          .run();
      }),

    /** スレッドをすべての会話ごと消す。消した会話の id を返す。 */
    deleteGroup: (groupId: string): Result.Result<string[], DatabaseError> =>
      run(() =>
        db
          .delete(chats)
          .where(eq(chats.groupId, groupId))
          .returning({ id: chats.id })
          .all()
          .map((row) => row.id),
      ),

    /** この会話を開いたことを記録する（スレッドを開き直したときに表示する会話）。 */
    markSelected: (chatId: string): Result.Result<void, DatabaseError> =>
      run(() => {
        db.update(chats)
          .set({ lastSelectedAt: new Date() })
          .where(eq(chats.id, chatId))
          .run();
      }),

    /**
     * 会話の所属タスクを変える（null で未所属）。
     * 一覧の並びが変わらないよう updatedAt は動かさない。
     */
    setTask: (
      chatId: string,
      taskId: string | null,
    ): Result.Result<ChatRow, ChatNotFoundError | DatabaseError> =>
      Result.pipe(
        run(() =>
          db
            .update(chats)
            .set({ taskId })
            .where(eq(chats.id, chatId))
            .returning()
            .get(),
        ),
        Result.andThen((row) => requireChat(row, chatId)),
      ),

    /** 最後に取れたコンテキストの使用量を残す（#245）。一覧の並びは変えない。 */
    setContextUsage: (
      chatId: string,
      usage: ContextUsage,
    ): Result.Result<void, DatabaseError> =>
      run(() => {
        db.update(chats)
          .set({ contextUsage: usage })
          .where(eq(chats.id, chatId))
          .run();
      }),

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

    /** 回答の要約を metadata に書き足す。メッセージが無ければ何もしない。 */
    setMessageSummary: (
      messageId: string,
      summary: string,
    ): Result.Result<void, DatabaseError> =>
      run(() =>
        db.transaction((tx) => {
          const row = tx
            .select({ metadata: messages.metadata })
            .from(messages)
            .where(eq(messages.id, messageId))
            .get();
          if (row === undefined) return;
          const metadata =
            typeof row.metadata === "object" && row.metadata !== null
              ? row.metadata
              : {};
          tx.update(messages)
            .set({ metadata: { ...metadata, summary } })
            .where(eq(messages.id, messageId))
            .run();
        }),
      ),

    /** 会話の回答の要約（メッセージ id → 要約）。要約の無い回答は含めない。 */
    listMessageSummaries: (
      chatId: string,
    ): Result.Result<Record<string, string>, DatabaseError> =>
      run(() => {
        const rows = db
          .select({ id: messages.id, metadata: messages.metadata })
          .from(messages)
          .where(
            and(eq(messages.chatId, chatId), eq(messages.role, "assistant")),
          )
          .all();
        const summaries: Record<string, string> = {};
        for (const row of rows) {
          const summary =
            typeof row.metadata === "object" && row.metadata !== null
              ? (row.metadata as { summary?: unknown }).summary
              : undefined;
          if (typeof summary === "string") summaries[row.id] = summary;
        }
        return summaries;
      }),

    /**
     * 会話の中の分岐点（#235）。同じスレッドのほかの会話が、この会話のどの回答から分岐したか。
     * 分岐した会話は分岐元の履歴を新しい id で写すので、id ではなく、写しても変わらない
     * 作成日時・役割・SDK の uuid が同じメッセージを同じ回答とみなす。
     * 分岐元をあとで編集・再生成して、分岐点の回答が無くなった会話は含めない。
     */
    listForkPoints: (
      chatId: string,
    ): Result.Result<ForkPoint[], ChatNotFoundError | DatabaseError> =>
      Result.pipe(
        run(() => db.select().from(chats).where(eq(chats.id, chatId)).get()),
        Result.andThen((row) => requireChat(row, chatId)),
        Result.andThen((chat) =>
          run(() => {
            const own = db
              .select()
              .from(messages)
              .where(eq(messages.chatId, chat.id))
              .orderBy(asc(messages.seq))
              .all();
            const others = db
              .select()
              .from(chats)
              .where(eq(chats.groupId, chat.groupId))
              .orderBy(asc(chats.createdAt))
              .all()
              .filter((other) => other.id !== chat.id);
            // 祖先の会話はこの会話と同じ流れなので、祖先の分岐点では分かれていない
            const byId = new Map(others.map((other) => [other.id, other]));
            const ancestors = new Set<string>();
            for (
              let parentId = chat.parentId;
              parentId !== null && !ancestors.has(parentId);
              parentId = byId.get(parentId)?.parentId ?? null
            ) {
              ancestors.add(parentId);
            }
            const points = new Map<string, Omit<ForkPoint, "messageId">>();
            for (const other of others) {
              if (
                other.parentId === null ||
                other.inheritedCount === 0 ||
                ancestors.has(other.id)
              ) {
                continue;
              }
              // 分岐点の回答は、分岐した会話が写した最後のメッセージ。分岐元を編集して
              // 元の回答が消えていても、写しから分かる
              const fork = db
                .select()
                .from(messages)
                .where(
                  and(
                    eq(messages.chatId, other.id),
                    eq(messages.seq, other.inheritedCount - 1),
                  ),
                )
                .get();
              if (fork === undefined) continue;
              const match = own.find(
                (message) =>
                  message.role === fork.role &&
                  message.sdkUuid === fork.sdkUuid &&
                  message.createdAt.getTime() === fork.createdAt.getTime(),
              );
              if (match === undefined) continue;
              const point = points.get(match.id) ?? { chatIds: [], quotes: [] };
              point.chatIds.push(other.id);
              // 回答の一部を引用して分岐した会話なら、その引用（#239）。
              // 分岐した会話の最初の質問に付いている
              const question = db
                .select({ parts: messages.parts })
                .from(messages)
                .where(
                  and(
                    eq(messages.chatId, other.id),
                    eq(messages.seq, other.inheritedCount),
                  ),
                )
                .get();
              const quote = quotesOf(
                (question?.parts ?? []) as { type: string; data?: unknown }[],
              ).find(
                (q): q is AnswerQuote =>
                  !isWikiPageQuote(q) &&
                  q.sourceMessageId === other.forkMessageId,
              );
              if (quote !== undefined) {
                point.quotes.push({
                  chatId: other.id,
                  text: quote.text,
                  ...(quote.range === undefined ? {} : { range: quote.range }),
                  question: questionTextOf(question?.parts ?? []),
                });
              }
              points.set(match.id, point);
            }
            return [...points].map(([messageId, point]) => ({
              messageId,
              ...point,
            }));
          }),
        ),
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
