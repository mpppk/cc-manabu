import { and, count, desc, eq, inArray, lte, notInArray } from "drizzle-orm";
import type { Db } from "./index.ts";
import {
  chats,
  type WikiPageRow,
  type WikiPageVersionRow,
  type WikiVersionActor,
  type WikiVersionOp,
  wikiCheckpoints,
  wikiPages,
  wikiPageVersions,
} from "./schema.ts";

/**
 * Wiki ページの版を記録する、トランザクションの中で使う関数（#166）。
 * ページの作成・更新・削除は、必ずここを通して版を 1 行追加する。
 */

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 1 ページあたりに残す版の上限。超えたら古い版から消す（チェックポイントが使う版は残す）。 */
export const MAX_VERSIONS_PER_PAGE = 200;

/** 変更の出どころ。版に残す。 */
export type WikiChange = {
  actor: WikiVersionActor;
  /** 一緒に元に戻す変更のまとまり。無ければ、この変更だけのまとまりにする。 */
  batchId?: string | undefined;
  op?: WikiVersionOp | undefined;
  reverts?: string | null | undefined;
  restoredFrom?: string | null | undefined;
  /** 変更した会話・回答・ツール。 */
  chatId?: string | null | undefined;
  messageId?: string | null | undefined;
  tool?: string | null | undefined;
};

/** 利用者が Wiki 画面で変えたとき。 */
export const USER_CHANGE: WikiChange = { actor: "user" };

/** ページの中身（版に残し、復元で戻すもの）。 */
export type PageState = Pick<
  WikiPageRow,
  "title" | "aliases" | "body" | "origin" | "sourceChatId" | "sourceMessageId"
>;

export const stateOf = (
  row: PageState & { deleted?: boolean },
): PageState | null =>
  row.deleted === true
    ? null
    : {
        title: row.title,
        aliases: row.aliases,
        body: row.body,
        origin: row.origin,
        sourceChatId: row.sourceChatId,
        sourceMessageId: row.sourceMessageId,
      };

/** 利用者から見て同じ内容か（タイトル・別名・本文。無いもの同士も同じ）。 */
export const sameContent = (
  a: PageState | null,
  b: PageState | null,
): boolean =>
  a === null || b === null
    ? a === b
    : a.title === b.title &&
      JSON.stringify(a.aliases) === JSON.stringify(b.aliases) &&
      a.body === b.body;

/** 版を 1 行追加する。 */
export const recordVersion = (
  tx: Tx,
  input: {
    wikiId: string;
    pageId: string;
    state: PageState;
    deleted: boolean;
    change: WikiChange;
    batchId: string;
  },
): void => {
  const { change } = input;
  tx.insert(wikiPageVersions)
    .values({
      wikiId: input.wikiId,
      pageId: input.pageId,
      title: input.state.title,
      aliases: input.state.aliases,
      body: input.state.body,
      deleted: input.deleted,
      origin: input.state.origin,
      sourceChatId: input.state.sourceChatId,
      sourceMessageId: input.state.sourceMessageId,
      op: change.op ?? "change",
      actor: change.actor,
      batchId: input.batchId,
      reverts: change.reverts ?? null,
      restoredFrom: change.restoredFrom ?? null,
      chatId: change.chatId ?? null,
      messageId: change.messageId ?? null,
      tool: change.tool ?? null,
      createdAt: new Date(),
    })
    .run();
  prunePage(tx, input.wikiId, input.pageId);
};

/** seq 以前の、ページの最後の版。無ければ undefined。 */
export const versionAt = (
  tx: Tx,
  pageId: string,
  seq: number,
): WikiPageVersionRow | undefined =>
  tx
    .select()
    .from(wikiPageVersions)
    .where(
      and(eq(wikiPageVersions.pageId, pageId), lte(wikiPageVersions.seq, seq)),
    )
    .orderBy(desc(wikiPageVersions.seq))
    .limit(1)
    .get();

/** Wiki の今の最後の版の seq（無ければ 0）。 */
export const latestSeq = (tx: Tx, wikiId: string): number =>
  tx
    .select({ seq: wikiPageVersions.seq })
    .from(wikiPageVersions)
    .where(eq(wikiPageVersions.wikiId, wikiId))
    .orderBy(desc(wikiPageVersions.seq))
    .limit(1)
    .get()?.seq ?? 0;

/**
 * ページを target の状態にする（null なら削除）。今と同じ内容なら何もしない。
 * 変えたら版を記録して true を返す。
 */
export const applyPageState = (
  tx: Tx,
  input: {
    wikiId: string;
    pageId: string;
    target: PageState | null;
    change: WikiChange;
    batchId: string;
  },
): boolean => {
  const current = tx
    .select()
    .from(wikiPages)
    .where(eq(wikiPages.id, input.pageId))
    .get();
  const { target } = input;
  if (current === undefined && target === null) return false;
  if (current !== undefined && target === null) {
    tx.delete(wikiPages).where(eq(wikiPages.id, input.pageId)).run();
    recordVersion(tx, { ...input, state: current, deleted: true });
    return true;
  }
  if (target === null) return false;
  if (
    current !== undefined &&
    sameContent(current, target) &&
    current.origin === target.origin
  ) {
    return false;
  }
  // 元の会話が消えていれば、ページからのリンクは外す（外部キー）
  const sourceChatId =
    target.sourceChatId !== null &&
    tx
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.id, target.sourceChatId))
      .get() !== undefined
      ? target.sourceChatId
      : null;
  const now = new Date();
  const values = {
    title: target.title,
    aliases: target.aliases,
    body: target.body,
    origin: target.origin,
    sourceChatId,
    sourceMessageId: sourceChatId === null ? null : target.sourceMessageId,
    updatedAt: now,
  };
  if (current === undefined) {
    tx.insert(wikiPages)
      .values({
        id: input.pageId,
        wikiId: input.wikiId,
        ...values,
        createdAt: now,
      })
      .run();
  } else {
    tx.update(wikiPages)
      .set(values)
      .where(eq(wikiPages.id, input.pageId))
      .run();
  }
  recordVersion(tx, { ...input, state: target, deleted: false });
  return true;
};

/**
 * 1 ページの版が上限を超えたら、古い版から消す。ただし、チェックポイントの時点の状態に使う版
 * （チェックポイントの seq 以前で最後の版）は残す。
 */
const prunePage = (tx: Tx, wikiId: string, pageId: string): void => {
  const total =
    tx
      .select({ n: count() })
      .from(wikiPageVersions)
      .where(eq(wikiPageVersions.pageId, pageId))
      .get()?.n ?? 0;
  if (total <= MAX_VERSIONS_PER_PAGE) return;
  const keep = new Set(
    tx
      .select({ seq: wikiPageVersions.seq })
      .from(wikiPageVersions)
      .where(eq(wikiPageVersions.pageId, pageId))
      .orderBy(desc(wikiPageVersions.seq))
      .limit(MAX_VERSIONS_PER_PAGE)
      .all()
      .map((row) => row.seq),
  );
  for (const checkpoint of tx
    .select({ seq: wikiCheckpoints.seq })
    .from(wikiCheckpoints)
    .where(eq(wikiCheckpoints.wikiId, wikiId))
    .all()) {
    const used = versionAt(tx, pageId, checkpoint.seq);
    if (used !== undefined) keep.add(used.seq);
  }
  tx.delete(wikiPageVersions)
    .where(
      and(
        eq(wikiPageVersions.pageId, pageId),
        notInArray(wikiPageVersions.seq, [...keep]),
      ),
    )
    .run();
};

/** 自動で作ったチェックポイントの上限（Wiki ごと）。超えたら古いものから消す。 */
export const MAX_AUTO_CHECKPOINTS = 50;

export const pruneAutoCheckpoints = (tx: Tx, wikiId: string): void => {
  const stale = tx
    .select({ id: wikiCheckpoints.id })
    .from(wikiCheckpoints)
    .where(
      and(eq(wikiCheckpoints.wikiId, wikiId), eq(wikiCheckpoints.auto, true)),
    )
    .orderBy(desc(wikiCheckpoints.seq), desc(wikiCheckpoints.createdAt))
    .all()
    .slice(MAX_AUTO_CHECKPOINTS)
    .map((row) => row.id);
  if (stale.length > 0) {
    tx.delete(wikiCheckpoints).where(inArray(wikiCheckpoints.id, stale)).run();
  }
};
