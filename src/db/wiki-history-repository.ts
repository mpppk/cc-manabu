import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { and, asc, desc, eq, max, ne } from "drizzle-orm";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";
import {
  type WikiCheckpointRow,
  type WikiPageVersionRow,
  wikiCheckpoints,
  wikiPages,
  wikiPageVersions,
} from "./schema.ts";
import {
  applyPageState,
  latestSeq,
  type PageState,
  pruneAutoCheckpoints,
  sameContent,
  stateOf,
  type Tx,
  versionAt,
  type WikiChange,
} from "./wiki-versions.ts";

/**
 * Wiki の変更履歴・元に戻す / やり直す・チェックポイント（#166）。
 *
 * 版（wiki_page_versions）は変更のたびに追加するだけで、消さない（上限を超えた古い版を除く）。
 * 元に戻す・やり直す・復元も、新しい版として記録する。
 * 元に戻す / やり直すの対象は、版の記録をまとまり（batch）ごとに順にたどって求める。
 */

export class WikiVersionNotFoundError extends ErrorFactory({
  name: "WikiVersionNotFoundError",
  message: "指定した版が見つかりません。",
}) {}

export class WikiCheckpointNotFoundError extends ErrorFactory({
  name: "WikiCheckpointNotFoundError",
  message: "チェックポイントが見つかりません。",
}) {}

export class NothingToUndoError extends ErrorFactory({
  name: "NothingToUndoError",
  message: (fields) =>
    fields.redo ? "やり直す変更はありません。" : "元に戻す変更はありません。",
  fields: ErrorFactory.fields<{ redo: boolean }>(),
}) {}

/** 後から別の変更が入っていて、戻すとその変更を上書きしてしまうとき。 */
export class WikiHistoryConflictError extends ErrorFactory({
  name: "WikiHistoryConflictError",
  message: (fields) =>
    `${fields.titles.map((title) => `「${title}」`).join("")}は、そのあとに別の変更が入っているため、上書きしないように${fields.redo ? "やり直し" : "元に戻し"}ませんでした。履歴で差分を確かめて、版を選んで復元してください。`,
  fields: ErrorFactory.fields<{ titles: string[]; redo: boolean }>(),
}) {}

const run = <T>(fn: () => T): Result.Result<T, DatabaseError> =>
  Result.try({ try: fn, catch: (cause) => new DatabaseError({ cause }) });

/** 変更のまとまり。 */
export type WikiBatch = {
  batchId: string;
  op: WikiPageVersionRow["op"];
  actor: WikiPageVersionRow["actor"];
  /** 変えたページ（タイトルは変更後。削除ならその直前）。 */
  pages: { pageId: string; title: string; deleted: boolean }[];
  chatId: string | null;
  messageId: string | null;
  createdAt: Date;
};

/** 元に戻せる・やり直せる変更（無ければ undefined）。 */
export type UndoState = {
  undo: WikiBatch | undefined;
  redo: WikiBatch | undefined;
};

type Failure<E> = { failure: E };
const isFailure = <T, E>(value: T | Failure<E>): value is Failure<E> =>
  typeof value === "object" && value !== null && "failure" in value;

/** 変更のまとまりの行（作った順）。 */
const batchRows = (tx: Tx, batchId: string): WikiPageVersionRow[] =>
  tx
    .select()
    .from(wikiPageVersions)
    .where(eq(wikiPageVersions.batchId, batchId))
    .orderBy(asc(wikiPageVersions.seq))
    .all();

const toBatch = (rows: WikiPageVersionRow[]): WikiBatch | undefined => {
  const first = rows[0];
  const last = rows.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const pages = new Map<
    string,
    { pageId: string; title: string; deleted: boolean }
  >();
  for (const row of rows) {
    pages.set(row.pageId, {
      pageId: row.pageId,
      title: row.title,
      deleted: row.deleted,
    });
  }
  return {
    batchId: first.batchId,
    op: first.op,
    actor: first.actor,
    pages: [...pages.values()],
    chatId: first.chatId,
    messageId: rows.find((row) => row.messageId !== null)?.messageId ?? null,
    createdAt: last.createdAt,
  };
};

/**
 * Wiki の版の記録をまとまりごとに順にたどり、元に戻せる変更（undo の山）と、
 * やり直せる変更（redo の山）を求める。新しい変更が入ると、やり直せる変更は消える。
 */
const stacksOf = (tx: Tx, wikiId: string) => {
  const batches = tx
    .select({
      batchId: wikiPageVersions.batchId,
      op: wikiPageVersions.op,
      reverts: wikiPageVersions.reverts,
      last: max(wikiPageVersions.seq),
    })
    .from(wikiPageVersions)
    .where(
      and(
        eq(wikiPageVersions.wikiId, wikiId),
        ne(wikiPageVersions.op, "baseline"),
      ),
    )
    .groupBy(wikiPageVersions.batchId)
    .orderBy(asc(max(wikiPageVersions.seq)))
    .all();
  let undo: string[] = [];
  let redo: string[] = [];
  for (const batch of batches) {
    if (batch.op === "change" || batch.op === "restore") {
      undo.push(batch.batchId);
      redo = [];
    } else if (batch.op === "undo" && batch.reverts !== null) {
      const reverted = batch.reverts;
      undo = undo.filter((id) => id !== reverted);
      redo.push(reverted);
    } else if (batch.op === "redo" && batch.reverts !== null) {
      const reapplied = batch.reverts;
      redo = redo.filter((id) => id !== reapplied);
      undo.push(reapplied);
    }
  }
  return { undo, redo };
};

/** ページの今の状態（無ければ null）。 */
const currentState = (tx: Tx, pageId: string): PageState | null => {
  const row = tx.select().from(wikiPages).where(eq(wikiPages.id, pageId)).get();
  return row === undefined ? null : stateOf(row);
};

/**
 * まとまり batchId を元に戻す（redo なら、もう一度当てる）。ページごとに、
 * 今の内容がそのまとまりの直後（redo なら直前）のままかを確かめ、後から別の変更が入っていれば
 * 何も変えずに失敗する（上書きしない）。
 */
const revertBatch = (
  tx: Tx,
  wikiId: string,
  batchId: string,
  redo: boolean,
): WikiBatch | Failure<WikiHistoryConflictError> => {
  const rows = batchRows(tx, batchId);
  const pageIds = [...new Set(rows.map((row) => row.pageId))];
  const plans = pageIds.map((pageId) => {
    const own = rows.filter((row) => row.pageId === pageId);
    const first = own[0] as WikiPageVersionRow;
    const last = own.at(-1) as WikiPageVersionRow;
    const previous = versionAt(tx, pageId, first.seq - 1);
    const before = previous === undefined ? null : stateOf(previous);
    const after = stateOf(last);
    return {
      pageId,
      title: last.title,
      expected: redo ? before : after,
      target: redo ? after : before,
    };
  });
  const conflicts = plans.filter(
    (plan) => !sameContent(currentState(tx, plan.pageId), plan.expected),
  );
  if (conflicts.length > 0) {
    return {
      failure: new WikiHistoryConflictError({
        titles: conflicts.map((plan) => plan.title),
        redo,
      }),
    };
  }
  const change: WikiChange = {
    actor: "user",
    op: redo ? "redo" : "undo",
    reverts: batchId,
  };
  const newBatch = crypto.randomUUID();
  for (const plan of plans) {
    applyPageState(tx, {
      wikiId,
      pageId: plan.pageId,
      target: plan.target,
      change,
      batchId: newBatch,
    });
  }
  return toBatch(rows) as WikiBatch;
};

export const createWikiHistoryRepository = (db: Db) => {
  /**
   * トランザクションの中で fn を実行する。失敗（Failure）は書き込む前に判定するので、
   * 失敗を返したときは何も変わっていない。
   */
  const transact = <T, E>(
    fn: (tx: Tx) => T | Failure<E>,
  ): Result.Result<T, E | DatabaseError> =>
    Result.pipe(
      run(() => db.transaction((tx) => fn(tx))),
      Result.andThen((value) =>
        isFailure(value) ? Result.fail(value.failure) : Result.succeed(value),
      ),
    );

  return {
    /** ページの版（新しい順）。 */
    listPageVersions: (
      pageId: string,
    ): Result.Result<WikiPageVersionRow[], DatabaseError> =>
      run(() =>
        db
          .select()
          .from(wikiPageVersions)
          .where(eq(wikiPageVersions.pageId, pageId))
          .orderBy(desc(wikiPageVersions.seq))
          .all(),
      ),

    getVersion: (
      seq: number,
    ): Result.Result<
      WikiPageVersionRow,
      WikiVersionNotFoundError | DatabaseError
    > =>
      Result.pipe(
        run(() =>
          db
            .select()
            .from(wikiPageVersions)
            .where(eq(wikiPageVersions.seq, seq))
            .get(),
        ),
        Result.andThen((row) =>
          row === undefined
            ? Result.fail(new WikiVersionNotFoundError())
            : Result.succeed(row),
        ),
      ),

    /** 削除したページ（最後の版が削除のもの。新しく消した順）。 */
    listDeletedPages: (
      wikiId: string,
    ): Result.Result<WikiPageVersionRow[], DatabaseError> =>
      run(() => {
        const latest = new Map<string, WikiPageVersionRow>();
        for (const row of db
          .select()
          .from(wikiPageVersions)
          .where(eq(wikiPageVersions.wikiId, wikiId))
          .orderBy(asc(wikiPageVersions.seq))
          .all()) {
          latest.set(row.pageId, row);
        }
        return [...latest.values()]
          .filter((row) => row.deleted)
          .sort((a, b) => b.seq - a.seq);
      }),

    /** 元に戻せる・やり直せる変更。 */
    undoState: (wikiId: string): Result.Result<UndoState, DatabaseError> =>
      run(() =>
        db.transaction((tx) => {
          const { undo, redo } = stacksOf(tx, wikiId);
          const top = (ids: string[]) => {
            const id = ids.at(-1);
            return id === undefined ? undefined : toBatch(batchRows(tx, id));
          };
          return { undo: top(undo), redo: top(redo) };
        }),
      ),

    /** 直前の変更を元に戻す（redo なら、戻した変更をやり直す）。 */
    undo: (
      wikiId: string,
      redo = false,
    ): Result.Result<
      WikiBatch,
      NothingToUndoError | WikiHistoryConflictError | DatabaseError
    > =>
      transact<WikiBatch, NothingToUndoError | WikiHistoryConflictError>(
        (tx) => {
          const stacks = stacksOf(tx, wikiId);
          const target = (redo ? stacks.redo : stacks.undo).at(-1);
          if (target === undefined) {
            return { failure: new NothingToUndoError({ redo }) };
          }
          return revertBatch(tx, wikiId, target, redo);
        },
      ),

    /**
     * 回答（messageId）で Claude が Wiki に加えた変更を、まとめて元に戻す（redo ならやり直す）。
     */
    undoAnswer: (
      messageId: string,
      redo = false,
    ): Result.Result<
      WikiBatch,
      NothingToUndoError | WikiHistoryConflictError | DatabaseError
    > =>
      transact<WikiBatch, NothingToUndoError | WikiHistoryConflictError>(
        (tx) => {
          const row = tx
            .select()
            .from(wikiPageVersions)
            .where(
              and(
                eq(wikiPageVersions.messageId, messageId),
                eq(wikiPageVersions.actor, "claude"),
                eq(wikiPageVersions.op, "change"),
              ),
            )
            .get();
          if (row === undefined) {
            return { failure: new NothingToUndoError({ redo }) };
          }
          const stacks = stacksOf(tx, row.wikiId);
          const applied = stacks.undo.includes(row.batchId);
          if (redo ? !stacks.redo.includes(row.batchId) : !applied) {
            return { failure: new NothingToUndoError({ redo }) };
          }
          return revertBatch(tx, row.wikiId, row.batchId, redo);
        },
      ),

    /** 回答で Claude が Wiki に加えた変更（無ければ undefined）と、元に戻したか。 */
    answerChanges: (
      messageId: string,
    ): Result.Result<
      { batch: WikiBatch; undone: boolean } | undefined,
      DatabaseError
    > =>
      run(() =>
        db.transaction((tx) => {
          const row = tx
            .select()
            .from(wikiPageVersions)
            .where(
              and(
                eq(wikiPageVersions.messageId, messageId),
                eq(wikiPageVersions.actor, "claude"),
                eq(wikiPageVersions.op, "change"),
              ),
            )
            .get();
          if (row === undefined) return undefined;
          const batch = toBatch(batchRows(tx, row.batchId));
          if (batch === undefined) return undefined;
          return {
            batch,
            undone: !stacksOf(tx, row.wikiId).undo.includes(row.batchId),
          };
        }),
      ),

    /** 回答が終わったら、その回答で Claude が加えた変更に回答の id を付ける。 */
    attachAnswer: (
      batchId: string,
      messageId: string,
    ): Result.Result<void, DatabaseError> =>
      run(() => {
        db.update(wikiPageVersions)
          .set({ messageId })
          .where(eq(wikiPageVersions.batchId, batchId))
          .run();
      }),

    /** 版の内容でページを復元する（削除したページも戻す）。復元も新しい版になる。 */
    restoreVersion: (
      seq: number,
    ): Result.Result<
      WikiPageVersionRow,
      WikiVersionNotFoundError | DatabaseError
    > =>
      transact<WikiPageVersionRow, WikiVersionNotFoundError>((tx) => {
        const version = tx
          .select()
          .from(wikiPageVersions)
          .where(eq(wikiPageVersions.seq, seq))
          .get();
        if (version === undefined) {
          return { failure: new WikiVersionNotFoundError() };
        }
        // 削除の版を選んだら、削除直前の内容に戻す
        applyPageState(tx, {
          wikiId: version.wikiId,
          pageId: version.pageId,
          target: stateOf({ ...version, deleted: false }),
          change: {
            actor: "user",
            op: "restore",
            restoredFrom: String(seq),
          },
          batchId: crypto.randomUUID(),
        });
        return version;
      }),

    listCheckpoints: (
      wikiId: string,
    ): Result.Result<WikiCheckpointRow[], DatabaseError> =>
      run(() =>
        db
          .select()
          .from(wikiCheckpoints)
          .where(eq(wikiCheckpoints.wikiId, wikiId))
          .orderBy(desc(wikiCheckpoints.seq), desc(wikiCheckpoints.createdAt))
          .all(),
      ),

    /** 今の Wiki 全体の状態に名前を付けて残す。 */
    createCheckpoint: (input: {
      wikiId: string;
      name: string;
      auto?: boolean;
      chatId?: string | null;
      batchId?: string | null;
    }): Result.Result<WikiCheckpointRow, DatabaseError> =>
      run(() =>
        db.transaction((tx) => {
          const row = tx
            .insert(wikiCheckpoints)
            .values({
              id: crypto.randomUUID(),
              wikiId: input.wikiId,
              name: input.name,
              auto: input.auto ?? false,
              seq: latestSeq(tx, input.wikiId),
              chatId: input.chatId ?? null,
              batchId: input.batchId ?? null,
              createdAt: new Date(),
            })
            .returning()
            .get();
          if (row.auto) pruneAutoCheckpoints(tx, input.wikiId);
          return row;
        }),
      ),

    /**
     * Wiki 全体をチェックポイントの時点の状態にする（ページの追加・削除を含む）。
     * 戻す操作も 1 つの変更として記録するので、元に戻せる。変えたページの数を返す。
     */
    restoreCheckpoint: (
      checkpointId: string,
    ): Result.Result<number, WikiCheckpointNotFoundError | DatabaseError> =>
      transact<number, WikiCheckpointNotFoundError>((tx) => {
        const checkpoint = tx
          .select()
          .from(wikiCheckpoints)
          .where(eq(wikiCheckpoints.id, checkpointId))
          .get();
        if (checkpoint === undefined) {
          return { failure: new WikiCheckpointNotFoundError() };
        }
        const pageIds = new Set([
          ...tx
            .selectDistinct({ pageId: wikiPageVersions.pageId })
            .from(wikiPageVersions)
            .where(eq(wikiPageVersions.wikiId, checkpoint.wikiId))
            .all()
            .map((row) => row.pageId),
          ...tx
            .select({ id: wikiPages.id })
            .from(wikiPages)
            .where(eq(wikiPages.wikiId, checkpoint.wikiId))
            .all()
            .map((row) => row.id),
        ]);
        const batchId = crypto.randomUUID();
        let changed = 0;
        for (const pageId of pageIds) {
          const version = versionAt(tx, pageId, checkpoint.seq);
          const applied = applyPageState(tx, {
            wikiId: checkpoint.wikiId,
            pageId,
            target: version === undefined ? null : stateOf(version),
            change: {
              actor: "user",
              op: "restore",
              restoredFrom: checkpoint.id,
            },
            batchId,
          });
          if (applied) changed++;
        }
        return changed;
      }),
  };
};

export type WikiHistoryRepository = ReturnType<
  typeof createWikiHistoryRepository
>;
