import { useCallback, useEffect, useRef, useState } from "react";

/** メインの右に並べるカラム（#248）。identities のどれかが同じなら、同じものを開いているとみなす。 */
export type Column<T> = T & {
  key: string;
  /** 会話は `chat:<会話 ID>`（分岐ごと）、ノートは `page:<ノート ID>` など。 */
  identities: readonly string[];
};

/** メインのカラムのキー（スクロール・強調の対象）。 */
export const MAIN_COLUMN = "main";

/** 見出しを強調しておく時間。 */
const HIGHLIGHT_MS = 1600;

/**
 * すでに開いているカラムを探す。メインと同じものなら MAIN_COLUMN。
 */
export const findColumn = <T>(
  columns: readonly Column<T>[],
  identities: readonly string[],
  mainIdentities: readonly string[] = [],
): string | undefined => {
  if (identities.some((id) => mainIdentities.includes(id))) return MAIN_COLUMN;
  return columns.find((column) =>
    column.identities.some((id) => identities.includes(id)),
  )?.key;
};

/**
 * メインの右に開くカラムの状態（#248）。新しく開くと右端に足してそこまでスクロールし、
 * すでに開いているもの（メインを含む）なら、そのカラムまでスクロールして見出しを一時的に強調する。
 * 途中のカラムを閉じても、ほかのカラムはそのまま残る。
 */
export const useColumns = <T>(mainIdentities: readonly string[] = []) => {
  const [columns, setColumns] = useState<Column<T>[]>([]);
  const current = useRef(columns);
  current.current = columns;
  const mainRef = useRef(mainIdentities);
  mainRef.current = mainIdentities;
  /** スクロールして見せるカラム（nonce は同じカラムを続けて見せるため）。 */
  const [reveal, setReveal] = useState<{ key: string; nonce: number }>();
  const [highlight, setHighlight] = useState<{ key: string; nonce: number }>();

  const show = useCallback((key: string, emphasize: boolean) => {
    const nonce = Math.random();
    setReveal({ key, nonce });
    if (emphasize) setHighlight({ key, nonce });
  }, []);

  useEffect(() => {
    if (highlight === undefined) return;
    const timer = setTimeout(() => setHighlight(undefined), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  /** 開く。開いたカラム（すでに開いていればそのカラム）のキーを返す。 */
  const open = useCallback(
    (identities: readonly string[], value: T): string => {
      const existing = findColumn(current.current, identities, mainRef.current);
      if (existing !== undefined) {
        show(existing, true);
        return existing;
      }
      const key = crypto.randomUUID();
      const column = { ...value, key, identities } as Column<T>;
      current.current = [...current.current, column];
      setColumns(current.current);
      show(key, false);
      return key;
    },
    [show],
  );

  const close = useCallback((key: string) => {
    current.current = current.current.filter((column) => column.key !== key);
    setColumns(current.current);
  }, []);

  const closeWhere = useCallback(
    (predicate: (column: Column<T>) => boolean) => {
      const next = current.current.filter((column) => !predicate(column));
      if (next.length === current.current.length) return;
      current.current = next;
      setColumns(next);
    },
    [],
  );

  /** カラムが表しているものが分かった・変わったとき（サイドチャットの会話 ID など）。 */
  const addIdentity = useCallback((key: string, identity: string) => {
    if (
      current.current.some(
        (column) => column.key === key && column.identities.includes(identity),
      )
    ) {
      return;
    }
    current.current = current.current.map((column) =>
      column.key === key
        ? { ...column, identities: [...column.identities, identity] }
        : column,
    );
    setColumns(current.current);
  }, []);

  const clear = useCallback(() => {
    if (current.current.length === 0) return;
    current.current = [];
    setColumns([]);
  }, []);

  return {
    columns,
    open,
    close,
    closeWhere,
    addIdentity,
    clear,
    /** メイン（1 列目）に戻る。emphasize なら見出しを強調する。 */
    backToMain: (emphasize = false) => show(MAIN_COLUMN, emphasize),
    show,
    reveal,
    highlight: highlight?.key,
  };
};
