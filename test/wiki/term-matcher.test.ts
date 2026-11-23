import { expect, test } from "bun:test";
import { createTermMatcher } from "../../src/wiki/term-matcher.ts";

const match = createTermMatcher([
  { pageId: "tuple", names: ["関係タプル", "relation tuple"] },
  { pageId: "tuple-short", names: ["タプル"] },
  { pageId: "fga", names: ["OpenFGA"] },
  { pageId: "ai", names: ["AI", "x"] },
]);

const pick = (text: string) =>
  match(text).map(({ start, end, pageId }) => [text.slice(start, end), pageId]);

test("日本語の名前と英語の別名から同じページに結び付ける", () => {
  expect(pick("関係タプルは Relation Tuple とも呼ぶ")).toEqual([
    ["関係タプル", "tuple"],
    ["Relation Tuple", "tuple"],
  ]);
});

test("重なる一致では長い語を優先する", () => {
  expect(pick("関係タプルとタプル")).toEqual([
    ["関係タプル", "tuple"],
    ["タプル", "tuple-short"],
  ]);
});

test("英数字の語は単語の途中に一致させず、1 文字の語は使わない", () => {
  expect(pick("said AI x OpenFGAs openfga")).toEqual([
    ["AI", "ai"],
    ["openfga", "fga"],
  ]);
});

test("用語が無ければ何も返さない", () => {
  expect(createTermMatcher([])("関係タプル")).toEqual([]);
  expect(match("関係ない文")).toEqual([]);
});
