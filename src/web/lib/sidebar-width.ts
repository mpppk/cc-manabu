/** 左サイドバーの幅（#185）。 */

/** 幅を保存していないときの幅（従来の w-64）。 */
export const DEFAULT_SIDEBAR_WIDTH = 256;
/** サイドバー上部のボタンが並びきる幅。 */
export const MIN_SIDEBAR_WIDTH = 232;
/** メインパネルの操作（ヘッダーと入力欄）に残す幅。 */
export const MIN_MAIN_WIDTH = 360;
/** キーボードで 1 回に変える幅。Shift を押すと大きく変える。 */
export const KEYBOARD_STEP = 16;
export const KEYBOARD_LARGE_STEP = 64;

// 改名前（#188）のキーのまま使い、ブラウザに保存した値を引き継ぐ
const STORAGE_KEY = "cc-manabu.sidebarWidth";

/** 画面幅に対して選べる範囲。画面が狭くても、サイドバーは最小幅を保つ。 */
export const sidebarWidthRange = (
  viewportWidth: number,
): { min: number; max: number } => ({
  min: MIN_SIDEBAR_WIDTH,
  max: Math.max(MIN_SIDEBAR_WIDTH, Math.floor(viewportWidth - MIN_MAIN_WIDTH)),
});

/** 幅を選べる範囲に収める。 */
export const clampSidebarWidth = (
  width: number,
  viewportWidth: number,
): number => {
  const { min, max } = sidebarWidthRange(viewportWidth);
  return Math.round(Math.min(max, Math.max(min, width)));
};

/** 保存した幅。保存していない・読めないときは undefined。 */
export const parseSidebarWidth = (
  value: string | null | undefined,
): number | undefined => {
  if (value == null || value === "") return undefined;
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? width : undefined;
};

export const loadSidebarWidth = (): number | undefined => {
  try {
    return parseSidebarWidth(localStorage.getItem(STORAGE_KEY));
  } catch {
    return undefined;
  }
};

export const saveSidebarWidth = (width: number) => {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // 覚えられなくても幅は変えられる
  }
};
