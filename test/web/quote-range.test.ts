import { describe, expect, test } from "bun:test";
import { locateQuote } from "../../src/web/lib/quote-range.ts";

describe("locateQuote", () => {
  const text = "方式A は速い。方式B は失敗時に再送する。方式B は遅い。";

  test("保存した位置が引用の文字列と合えば、その位置を使う", () => {
    const start = text.lastIndexOf("方式B");
    expect(
      locateQuote(text, { text: "方式B", range: { start, end: start + 3 } }),
    ).toEqual({ start, end: start + 3 });
  });

  test("位置が無ければ文字列で探す。段落の区切りの改行・空白の違いは気にしない", () => {
    // 選択範囲の文字列には段落の間の改行が入るが、本文の文字はつながっている
    const body = "見出し段落の本文";
    expect(locateQuote(body, { text: "見出し\n\n段落の 本文" })).toEqual({
      start: 0,
      end: body.length,
    });
    expect(locateQuote(text, { text: "失敗時に再送" })).toEqual({
      start: text.indexOf("失敗時"),
      end: text.indexOf("失敗時") + "失敗時に再送".length,
    });
  });

  test("位置が合わなければ（表示が変わった）、保存した位置にいちばん近い同じ文字列を選ぶ", () => {
    const second = text.lastIndexOf("方式B");
    expect(
      locateQuote(text, {
        text: "方式B",
        range: { start: second + 2, end: second + 5 },
      }),
    ).toEqual({ start: second, end: second + 3 });
  });

  test("見つからない・空の引用は undefined", () => {
    expect(locateQuote(text, { text: "方式C" })).toBeUndefined();
    expect(locateQuote(text, { text: " \n" })).toBeUndefined();
    expect(
      locateQuote(text, { text: "方式A", range: { start: 0, end: 999 } }),
    ).toEqual({ start: 0, end: 3 });
  });
});
