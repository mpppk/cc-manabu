import { expect, test } from "bun:test";
import { lineDiff } from "../../src/web/lib/diff.ts";

test("変わった行だけを削除・追加にする", () => {
  expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
    { type: "same", text: "a" },
    { type: "remove", text: "b" },
    { type: "add", text: "B" },
    { type: "same", text: "c" },
    { type: "add", text: "d" },
  ]);
});

test("空の版との比較は、すべて追加・削除になる", () => {
  expect(lineDiff("", "x\ny")).toEqual([
    { type: "add", text: "x" },
    { type: "add", text: "y" },
  ]);
  expect(lineDiff("x", "")).toEqual([{ type: "remove", text: "x" }]);
  expect(lineDiff("same", "same")).toEqual([{ type: "same", text: "same" }]);
});
