import { describe, expect, test } from "bun:test";
import {
  clampSidebarWidth,
  MIN_MAIN_WIDTH,
  MIN_SIDEBAR_WIDTH,
  parseSidebarWidth,
  sidebarWidthRange,
} from "../../src/web/lib/sidebar-width.ts";

describe("サイドバーの幅（#185）", () => {
  test("メインパネルの幅を残す範囲に収める", () => {
    expect(sidebarWidthRange(1280)).toEqual({
      min: MIN_SIDEBAR_WIDTH,
      max: 1280 - MIN_MAIN_WIDTH,
    });
    expect(clampSidebarWidth(400, 1280)).toBe(400);
    expect(clampSidebarWidth(100, 1280)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(5000, 1280)).toBe(1280 - MIN_MAIN_WIDTH);
  });

  test("画面が狭くても、サイドバーは最小幅を保つ", () => {
    expect(sidebarWidthRange(400)).toEqual({
      min: MIN_SIDEBAR_WIDTH,
      max: MIN_SIDEBAR_WIDTH,
    });
    expect(clampSidebarWidth(300, 400)).toBe(MIN_SIDEBAR_WIDTH);
  });

  test.each([
    [null, undefined],
    ["", undefined],
    ["abc", undefined],
    ["-10", undefined],
    ["320", 320],
  ])("保存値 %p は %p として読む", (value, expected) => {
    expect(parseSidebarWidth(value)).toBe(expected);
  });
});
