import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SIDE_PANEL_MAX_WIDTH,
  MIN_SIDE_PANEL_WIDTH,
  resolveSidePanelWidth,
  sidePanelWidthRange,
} from "../../src/web/lib/side-panel-width.ts";
import {
  clampSidebarWidth,
  MIN_MAIN_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from "../../src/web/lib/sidebar-width.ts";

describe("右側のペインの幅（#209）", () => {
  test("並べる領域から、メインの幅を残す範囲に収める", () => {
    expect(sidePanelWidthRange(1200)).toEqual({
      min: MIN_SIDE_PANEL_WIDTH,
      max: 1200 - MIN_MAIN_WIDTH,
    });
    expect(resolveSidePanelWidth(600, 1200)).toBe(600);
    expect(resolveSidePanelWidth(100, 1200)).toBe(MIN_SIDE_PANEL_WIDTH);
    expect(resolveSidePanelWidth(5000, 1200)).toBe(1200 - MIN_MAIN_WIDTH);
  });

  test("保存していなければ、並べる領域の 42% を既定の範囲に収める", () => {
    expect(resolveSidePanelWidth(undefined, 1000)).toBe(420);
    expect(resolveSidePanelWidth(undefined, 2000)).toBe(
      DEFAULT_SIDE_PANEL_MAX_WIDTH,
    );
    expect(resolveSidePanelWidth(undefined, 600)).toBe(MIN_SIDE_PANEL_WIDTH);
  });

  test("領域が狭くても、右側のペインは最小幅を保つ", () => {
    expect(sidePanelWidthRange(500)).toEqual({
      min: MIN_SIDE_PANEL_WIDTH,
      max: MIN_SIDE_PANEL_WIDTH,
    });
  });

  test("右側のペインを開いている間、左サイドバーはその幅を残して広がる", () => {
    expect(clampSidebarWidth(5000, 1600, MIN_SIDE_PANEL_WIDTH)).toBe(
      1600 - MIN_MAIN_WIDTH - MIN_SIDE_PANEL_WIDTH,
    );
    expect(clampSidebarWidth(5000, 800, MIN_SIDE_PANEL_WIDTH)).toBe(
      MIN_SIDEBAR_WIDTH,
    );
  });
});
