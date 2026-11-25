/**
 * SQLite の WAL ファイル（`*.sqlite-wal`）を、DB 本体のバイト列に適用する。
 *
 * CLI 版の DB は WAL モードで、閉じてもチェックポイントされずにデータが WAL に残っていることがある。
 * sql.js は WAL を読めないので、取り込むときにここで本体へ書き戻す。
 * 形式: https://www.sqlite.org/fileformat2.html#the_write_ahead_log
 */

const WAL_HEADER_SIZE = 32;
const FRAME_HEADER_SIZE = 24;

const readU32 = (view: DataView, offset: number, bigEndian: boolean) =>
  view.getUint32(offset, !bigEndian);

/** WAL のチェックサム（2 語ずつ足し込む）。s は前のフレームから引き継ぐ。 */
const checksum = (
  bytes: Uint8Array,
  start: number,
  length: number,
  bigEndian: boolean,
  initial: [number, number],
): [number, number] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let [s0, s1] = initial;
  for (let offset = start; offset < start + length; offset += 8) {
    s0 = (s0 + readU32(view, offset, bigEndian) + s1) >>> 0;
    s1 = (s1 + readU32(view, offset + 4, bigEndian) + s0) >>> 0;
  }
  return [s0, s1];
};

/** DB 本体のヘッダからページサイズを読む（1 は 65536）。 */
const pageSizeOf = (db: Uint8Array): number | undefined => {
  if (db.length < 100) return undefined;
  const raw = (db[16] ?? 0) * 256 + (db[17] ?? 0);
  return raw === 1 ? 65536 : raw;
};

export type WalApplyResult = {
  bytes: Uint8Array;
  /** 適用したコミット済みのフレームの数。 */
  frames: number;
};

/**
 * WAL のコミット済みのフレームを本体に書き込んだバイト列を返す。
 * WAL が空・壊れている・ソルトが合わないなどで使えなければ、本体をそのまま返す。
 */
export const applyWal = (db: Uint8Array, wal: Uint8Array): WalApplyResult => {
  if (wal.length < WAL_HEADER_SIZE) return { bytes: db, frames: 0 };
  const view = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) {
    return { bytes: db, frames: 0 };
  }
  const bigEndian = (magic & 1) === 1;
  const pageSize = view.getUint32(8, false);
  const salt1 = view.getUint32(16, false);
  const salt2 = view.getUint32(20, false);
  let sums = checksum(wal, 0, 24, bigEndian, [0, 0]);
  if (
    sums[0] !== view.getUint32(24, false) ||
    sums[1] !== view.getUint32(28, false)
  ) {
    return { bytes: db, frames: 0 };
  }
  const dbPageSize = pageSizeOf(db);
  if (dbPageSize !== undefined && dbPageSize !== pageSize) {
    return { bytes: db, frames: 0 };
  }

  const committed = new Map<number, number>();
  const pending = new Map<number, number>();
  let dbPages: number | undefined;
  let frames = 0;
  let pendingFrames = 0;
  for (
    let offset = WAL_HEADER_SIZE;
    offset + FRAME_HEADER_SIZE + pageSize <= wal.length;
    offset += FRAME_HEADER_SIZE + pageSize
  ) {
    const pageNumber = view.getUint32(offset, false);
    const commitPages = view.getUint32(offset + 4, false);
    if (
      view.getUint32(offset + 8, false) !== salt1 ||
      view.getUint32(offset + 12, false) !== salt2
    ) {
      break;
    }
    sums = checksum(wal, offset, 8, bigEndian, sums);
    sums = checksum(wal, offset + FRAME_HEADER_SIZE, pageSize, bigEndian, sums);
    if (
      sums[0] !== view.getUint32(offset + 16, false) ||
      sums[1] !== view.getUint32(offset + 20, false)
    ) {
      break;
    }
    pending.set(pageNumber, offset + FRAME_HEADER_SIZE);
    pendingFrames += 1;
    if (commitPages !== 0) {
      for (const [page, dataOffset] of pending) committed.set(page, dataOffset);
      pending.clear();
      frames += pendingFrames;
      pendingFrames = 0;
      dbPages = commitPages;
    }
  }
  if (dbPages === undefined) return { bytes: db, frames: 0 };

  const bytes = new Uint8Array(dbPages * pageSize);
  bytes.set(db.subarray(0, Math.min(db.length, bytes.length)));
  for (const [page, dataOffset] of committed) {
    if (page < 1 || page > dbPages) continue;
    bytes.set(
      wal.subarray(dataOffset, dataOffset + pageSize),
      (page - 1) * pageSize,
    );
  }
  return { bytes, frames };
};
