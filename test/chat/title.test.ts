import { describe, expect, test } from "bun:test";
import { makeTitle, TITLE_MAX_LENGTH } from "../../src/chat/title.ts";

describe("makeTitle", () => {
  test("短い発話はそのまま", () => {
    expect(makeTitle("TypeScript の型について")).toBe(
      "TypeScript の型について",
    );
  });

  test("改行や連続する空白は 1 つの空白にまとめる", () => {
    expect(makeTitle("  一行目\n\n二行目\t三  ")).toBe("一行目 二行目 三");
  });

  test("長い発話は省略記号付きで切り詰める", () => {
    const title = makeTitle("あ".repeat(100));
    expect([...title]).toHaveLength(TITLE_MAX_LENGTH);
    expect(title.endsWith("…")).toBe(true);
  });

  test("コードブロックは除く", () => {
    expect(makeTitle("このコードを直して\n```ts\nconst a = 1;\n```")).toBe(
      "このコードを直して",
    );
  });

  test("サロゲートペアを途中で切らない", () => {
    const title = makeTitle("😀".repeat(100));
    expect(title).toBe(`${"😀".repeat(TITLE_MAX_LENGTH - 1)}…`);
  });

  test("空なら既定のタイトル", () => {
    expect(makeTitle("   ")).toBe("新しいスレッド");
  });
});
