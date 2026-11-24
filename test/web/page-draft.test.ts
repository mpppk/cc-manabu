import { expect, test } from "bun:test";
import { pageDraftFromSelection } from "../../src/web/lib/page-draft.ts";

test("1 行で短い選択はタイトルに、それ以外は本文に入れる（#121）", () => {
  expect(pageDraftFromSelection("  関係タプル \n")).toEqual({
    title: "関係タプル",
    body: "",
  });
  expect(pageDraftFromSelection("一行目\n二行目")).toEqual({
    title: "",
    body: "一行目\n二行目",
  });
  const long = "あ".repeat(41);
  expect(pageDraftFromSelection(long)).toEqual({ title: "", body: long });
});
