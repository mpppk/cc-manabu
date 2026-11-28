import { describe, expect, test } from "bun:test";
import {
  type Column,
  findColumn,
  MAIN_COLUMN,
} from "../../src/web/lib/columns.ts";

const columns: Column<{ kind: string }>[] = [
  { key: "a", kind: "chat", identities: ["chat:c1", "wikichat:p1"] },
  { key: "b", kind: "page", identities: ["page:p2"] },
];

describe("findColumn（#248）", () => {
  test("会話は分岐ごとの会話 ID、ノートはノート ID で、開いているカラムを見つける", () => {
    expect(findColumn(columns, ["chat:c1"])).toBe("a");
    expect(findColumn(columns, ["wikichat:p1"])).toBe("a");
    expect(findColumn(columns, ["page:p2"])).toBe("b");
    // 同じスレッドの別の分岐は別のカラム
    expect(findColumn(columns, ["chat:c2"])).toBeUndefined();
  });

  test("メインに出ているものは、メインのカラム", () => {
    expect(findColumn(columns, ["chat:main"], ["chat:main"])).toBe(MAIN_COLUMN);
    expect(findColumn(columns, ["page:p2"], ["page:p2"])).toBe(MAIN_COLUMN);
  });
});
