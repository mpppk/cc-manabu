import { describe, expect, test } from "bun:test";
import {
  type Column,
  type ColumnTree,
  closeColumn,
  emptyTree,
  findColumn,
  MAIN_COLUMN,
  openColumn,
  pathOf,
  siblingsOf,
  switchColumn,
} from "../../src/web/lib/columns.ts";

type Value = { label: string };

const open = (
  tree: ColumnTree<Value>,
  key: string,
  from: string,
  options: { identities?: string[]; main?: string[]; max?: number } = {},
) =>
  openColumn(tree, {
    key,
    identities: options.identities ?? [`page:${key}`],
    value: { label: key },
    from,
    ...(options.main === undefined ? {} : { mainIdentities: options.main }),
    ...(options.max === undefined ? {} : { max: options.max }),
  });

const keys = (tree: ColumnTree<Value>) => pathOf(tree).map((node) => node.key);

/** メイン → A → B と開いた状態。 */
const chain = () => {
  let tree = emptyTree<Value>();
  tree = open(tree, "A", MAIN_COLUMN).tree;
  tree = open(tree, "B", "A").tree;
  return tree;
};

describe("カラムの経路（#254）", () => {
  test("開いた元のカラムのすぐ右に開き、それより右の経路は隠して残す", () => {
    const tree = open(chain(), "C", MAIN_COLUMN).tree;
    expect(keys(tree)).toEqual(["C"]);
    expect(tree.nodes.map((node) => node.key)).toEqual(["A", "B", "C"]);
    expect(siblingsOf(tree, "C").map((node) => node.key)).toEqual(["A", "C"]);
    // 別の経路に切り替えると、A → B がそのまま戻る
    expect(keys(switchColumn(tree, "A"))).toEqual(["A", "B"]);
  });

  test("途中のカラムから開くと、その右だけを入れ替える", () => {
    const tree = open(chain(), "C", "A").tree;
    expect(keys(tree)).toEqual(["A", "C"]);
    expect(keys(switchColumn(tree, "B"))).toEqual(["A", "B"]);
  });

  test("セッション詳細など（end）は、表示している経路の右端に足す", () => {
    expect(keys(open(chain(), "D", "end").tree)).toEqual(["A", "B", "D"]);
  });

  test("表示している経路（メインを含む）にあるものは開かずにそのカラムを返す。隠した経路にあるものは新しく開く", () => {
    const tree = chain();
    expect(open(tree, "X", "B", { identities: ["page:A"] })).toMatchObject({
      kind: "existing",
      key: "A",
    });
    expect(
      open(tree, "X", "B", { identities: ["chat:m"], main: ["chat:m"] }),
    ).toMatchObject({ kind: "existing", key: MAIN_COLUMN });
    const hiddenA = open(tree, "C", MAIN_COLUMN).tree;
    const reopened = open(hiddenA, "A2", "C", { identities: ["page:A"] });
    expect(reopened.kind).toBe("opened");
    expect(keys(reopened.tree)).toEqual(["C", "A2"]);
  });

  test("閉じると、そこから開いたカラムも閉じ、同じ元の別の経路（最後に表示したもの）を出す", () => {
    let tree = open(chain(), "C", MAIN_COLUMN).tree;
    tree = switchColumn(tree, "A");
    tree = open(tree, "D", MAIN_COLUMN).tree;
    // メインから A（→ B）、C、D の 3 本。A が D の前に最後に表示した経路
    tree = closeColumn(tree, "D");
    expect(keys(tree)).toEqual(["A", "B"]);
    tree = closeColumn(tree, "A");
    expect(tree.nodes.map((node) => node.key)).toEqual(["C"]);
    expect(keys(tree)).toEqual(["C"]);
  });

  test("上限を超えたら、最後に表示したのが古い隠した経路から捨てる", () => {
    let tree = chain(); // A → B
    tree = open(tree, "C", MAIN_COLUMN).tree; // C（A → B は隠す）
    tree = open(tree, "D", MAIN_COLUMN, { max: 3 }).tree; // 4 個目
    expect(tree.nodes.map((node) => node.key)).toEqual(["C", "D"]);
    expect(keys(tree)).toEqual(["D"]);
  });
});

describe("findColumn（#248）", () => {
  const columns: Column<{ kind: string }>[] = [
    { key: "a", kind: "chat", identities: ["chat:c1", "wikichat:p1"] },
    { key: "b", kind: "page", identities: ["page:p2"] },
  ];

  test("会話は分岐ごとの会話 ID、ノートはノート ID で見つける", () => {
    expect(findColumn(columns, ["chat:c1"])).toBe("a");
    expect(findColumn(columns, ["wikichat:p1"])).toBe("a");
    expect(findColumn(columns, ["page:p2"])).toBe("b");
    expect(findColumn(columns, ["chat:c2"])).toBeUndefined();
  });

  test("メインに出ているものは、メインのカラム", () => {
    expect(findColumn(columns, ["chat:main"], ["chat:main"])).toBe(MAIN_COLUMN);
  });
});
