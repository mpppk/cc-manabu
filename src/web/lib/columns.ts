import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ColumnOrigin,
  captureOrigin,
  trackPointer,
} from "./column-origin.ts";

/**
 * メインの右に並べるカラム（#248）。identities のどれかが同じなら、同じものを開いているとみなす。
 */
export type Column<T> = T & {
  key: string;
  /** 会話は `chat:<会話 ID>`（分岐ごと）、ノートは `page:<ノート ID>` など。 */
  identities: readonly string[];
};

/** メインのカラムのキー（スクロール・強調の対象で、経路の根）。 */
export const MAIN_COLUMN = "main";

/** 隠した経路を含めて、開いておけるカラムの数（#254）。 */
export const MAX_COLUMNS = 10;

/**
 * カラムの経路（#254）。カラムは開いた元のカラム（parent）を持つ木になる。
 * 表示するのは、メインから各カラムの「表示している子」（active）をたどった 1 本の経路だけで、
 * ほかの枝は別の経路として隠しておく。
 */
export type ColumnNode<T> = Column<T> & {
  /** 開いた元のカラム（メインなら MAIN_COLUMN）。 */
  parent: string;
  /** 最後に表示した順（大きいほど新しい）。隠した経路を捨てる順に使う。 */
  shownAt: number;
  /** 開いた起点（元のカラムの中で強調する。#267）。分からなければ undefined。 */
  origin?: ColumnOrigin | undefined;
};

export type ColumnTree<T> = {
  /** 開いた順。 */
  nodes: readonly ColumnNode<T>[];
  /** カラム（とメイン）ごとの、表示している子。 */
  active: Readonly<Record<string, string>>;
  /** shownAt に使う、増え続ける番号。 */
  clock: number;
};

export const emptyTree = <T>(): ColumnTree<T> => ({
  nodes: [],
  active: {},
  clock: 0,
});

/** 表示している経路（メインの右から順に）。 */
export const pathOf = <T>(tree: ColumnTree<T>): ColumnNode<T>[] => {
  const path: ColumnNode<T>[] = [];
  let current = MAIN_COLUMN;
  for (;;) {
    const next = tree.active[current];
    const node = tree.nodes.find((item) => item.key === next);
    if (node === undefined) return path;
    path.push(node);
    current = node.key;
  }
};

/** key のカラムと、そこから開いたカラム（隠した経路を含む）のキー。 */
const subtreeOf = <T>(
  nodes: readonly ColumnNode<T>[],
  key: string,
): Set<string> => {
  const keys = new Set([key]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of nodes) {
      if (!keys.has(node.key) && keys.has(node.parent)) {
        keys.add(node.key);
        grew = true;
      }
    }
  }
  return keys;
};

/** 表示している経路のカラムに、表示した時刻を付ける。 */
const stamp = <T>(tree: ColumnTree<T>): ColumnTree<T> => {
  const clock = tree.clock + 1;
  const shown = new Set(pathOf(tree).map((node) => node.key));
  return {
    ...tree,
    clock,
    nodes: tree.nodes.map((node) =>
      shown.has(node.key) ? { ...node, shownAt: clock } : node,
    ),
  };
};

/** カラムとその子孫を取り除く。表示していたなら、同じ元から開いた別の経路（最後に表示したもの）に切り替える。 */
const removeSubtree = <T>(tree: ColumnTree<T>, key: string): ColumnTree<T> => {
  const target = tree.nodes.find((node) => node.key === key);
  if (target === undefined) return tree;
  const removed = subtreeOf(tree.nodes, key);
  const nodes = tree.nodes.filter((node) => !removed.has(node.key));
  const active = Object.fromEntries(
    Object.entries(tree.active).filter(
      ([parent, child]) => !removed.has(parent) && !removed.has(child),
    ),
  );
  if (tree.active[target.parent] === key) {
    const fallback = nodes
      .filter((node) => node.parent === target.parent)
      .sort((a, b) => b.shownAt - a.shownAt)[0];
    if (fallback !== undefined) active[target.parent] = fallback.key;
  }
  return { ...tree, nodes, active };
};

/** 隠した経路を、最後に表示したのが古いものから捨てて、カラムの数を上限に収める。 */
const evict = <T>(tree: ColumnTree<T>, max: number): ColumnTree<T> => {
  let current = tree;
  while (current.nodes.length > max) {
    const shown = new Set([
      MAIN_COLUMN,
      ...pathOf(current).map((node) => node.key),
    ]);
    // 隠した経路の根（表示しているカラムから開いた、表示していないカラム）
    const oldest = current.nodes
      .filter((node) => !shown.has(node.key) && shown.has(node.parent))
      .sort((a, b) => a.shownAt - b.shownAt)[0];
    if (oldest === undefined) return current;
    current = removeSubtree(current, oldest.key);
  }
  return current;
};

/**
 * すでに開いているカラムを探す。メインに出ているものなら MAIN_COLUMN。
 * 探すのは表示している経路だけ（隠した経路にあっても、今の経路に新しく開く）。
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

export type OpenResult<T> =
  | { kind: "existing"; key: string; tree: ColumnTree<T> }
  | { kind: "opened"; key: string; tree: ColumnTree<T> };

/**
 * from のカラムから開く（#254）。from のすぐ右に開き、それより右にあった経路は別の経路として隠す。
 * from が "end" なら、表示している経路の右端に足す（たどる対象ではないもの。セッション詳細など）。
 * 表示している経路（メインを含む）にすでにあれば、開かずにそのカラムを返す。
 * そのときは起点を今の起点に移す（最後に選んだ箇所を強調する。#267）。
 */
export const openColumn = <T>(
  tree: ColumnTree<T>,
  input: {
    key: string;
    identities: readonly string[];
    value: T;
    from: string | "end";
    mainIdentities?: readonly string[];
    max?: number;
    origin?: ColumnOrigin | undefined;
  },
): OpenResult<T> => {
  const path = pathOf(tree);
  const existing = findColumn(path, input.identities, input.mainIdentities);
  if (existing !== undefined) {
    if (existing === MAIN_COLUMN || input.origin === undefined) {
      return { kind: "existing", key: existing, tree };
    }
    return {
      kind: "existing",
      key: existing,
      tree: {
        ...tree,
        nodes: tree.nodes.map((node) =>
          node.key === existing ? { ...node, origin: input.origin } : node,
        ),
      },
    };
  }
  const parent =
    input.from === "end"
      ? (path.at(-1)?.key ?? MAIN_COLUMN)
      : input.from === MAIN_COLUMN ||
          path.some((node) => node.key === input.from)
        ? input.from
        : (path.at(-1)?.key ?? MAIN_COLUMN);
  const node = {
    ...input.value,
    key: input.key,
    identities: input.identities,
    parent,
    shownAt: tree.clock,
    origin: input.origin,
  } as ColumnNode<T>;
  const opened = stamp({
    ...tree,
    nodes: [...tree.nodes, node],
    active: { ...tree.active, [parent]: input.key },
  });
  return {
    kind: "opened",
    key: input.key,
    tree: evict(opened, input.max ?? MAX_COLUMNS),
  };
};

/** カラムを閉じる。そこから開いたカラム（右のカラムと、隠した経路）も閉じる。 */
export const closeColumn = <T>(
  tree: ColumnTree<T>,
  key: string,
): ColumnTree<T> => stamp(removeSubtree(tree, key));

/** 同じ元から開いた別の経路（key のカラム）に切り替える。 */
export const switchColumn = <T>(
  tree: ColumnTree<T>,
  key: string,
): ColumnTree<T> => {
  const node = tree.nodes.find((item) => item.key === key);
  if (node === undefined) return tree;
  return stamp({ ...tree, active: { ...tree.active, [node.parent]: key } });
};

/** 同じ元から開いたカラム（key を含む。開いた順）。 */
export const siblingsOf = <T>(
  tree: ColumnTree<T>,
  key: string,
): ColumnNode<T>[] => {
  const node = tree.nodes.find((item) => item.key === key);
  return node === undefined
    ? []
    : tree.nodes.filter((item) => item.parent === node.parent);
};

/** 見出しを強調しておく時間。 */
const HIGHLIGHT_MS = 1600;

/**
 * メインの右に開くカラムの状態（#248、#254）。
 * - 開くと、開いた元のカラムのすぐ右に出してそこまでスクロールする。それより右にあった経路は隠す
 * - 表示している経路（メインを含む）にすでにあるものなら、そのカラムまでスクロールして見出しを強調する
 * - 閉じると、そのカラムとそこから開いたカラムを閉じる
 */
export const useColumns = <T>(mainIdentities: readonly string[] = []) => {
  const [tree, setTree] = useState<ColumnTree<T>>(emptyTree);
  const current = useRef(tree);
  current.current = tree;
  const mainRef = useRef(mainIdentities);
  mainRef.current = mainIdentities;
  /** スクロールして見せるカラム（nonce は同じカラムを続けて見せるため）。 */
  const [reveal, setReveal] = useState<{ key: string; nonce: number }>();
  const [highlight, setHighlight] = useState<{ key: string; nonce: number }>();

  const update = useCallback((next: ColumnTree<T>) => {
    if (next === current.current) return;
    current.current = next;
    setTree(next);
  }, []);

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

  useEffect(trackPointer, []);

  /**
   * from のカラムから開く（"end" なら経路の右端に足す）。開いたカラム（すでにあればそのカラム）のキーを返す。
   * origin は開いた起点（#267）。省くと、今の選択範囲・フォーカス・押した要素から決める。null なら付けない。
   */
  const open = useCallback(
    (
      identities: readonly string[],
      value: T,
      from: string | "end",
      origin?: ColumnOrigin | null,
    ): string => {
      const result = openColumn(current.current, {
        key: crypto.randomUUID(),
        identities,
        value,
        from,
        mainIdentities: mainRef.current,
        origin: origin === null ? undefined : (origin ?? captureOrigin()),
      });
      update(result.tree);
      show(result.key, result.kind === "existing");
      return result.key;
    },
    [show, update],
  );

  const close = useCallback(
    (key: string) => update(closeColumn(current.current, key)),
    [update],
  );

  const switchTo = useCallback(
    (key: string) => {
      update(switchColumn(current.current, key));
      show(key, false);
    },
    [show, update],
  );

  const closeWhere = useCallback(
    (predicate: (column: ColumnNode<T>) => boolean) => {
      let next = current.current;
      for (const node of current.current.nodes) {
        if (predicate(node)) next = closeColumn(next, node.key);
      }
      update(next);
    },
    [update],
  );

  /** カラムが表しているものが分かった・変わったとき（サイドチャットの会話 ID など）。 */
  const addIdentity = useCallback(
    (key: string, identity: string) => {
      const tree = current.current;
      if (
        tree.nodes.some(
          (node) => node.key === key && node.identities.includes(identity),
        )
      ) {
        return;
      }
      update({
        ...tree,
        nodes: tree.nodes.map((node) =>
          node.key === key
            ? { ...node, identities: [...node.identities, identity] }
            : node,
        ),
      });
    },
    [update],
  );

  const clear = useCallback(() => {
    if (current.current.nodes.length > 0) update(emptyTree());
  }, [update]);

  const path = pathOf(tree);
  const shown = new Set(path.map((node) => node.key));
  return {
    /** 表示している経路のカラム（メインの右から順に）。 */
    columns: path,
    /** すべてのカラム（隠した経路を含む。開いた順）。 */
    all: tree.nodes,
    /** 隠している経路のカラム。消さずに描画しておく。 */
    hidden: tree.nodes.filter((node) => !shown.has(node.key)),
    /** 同じ元から開いたカラム（経路の切り替えの候補）。 */
    siblingsOf: (key: string) => siblingsOf(tree, key),
    open,
    close,
    switchTo,
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
