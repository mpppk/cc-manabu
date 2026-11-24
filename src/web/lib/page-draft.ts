/** 選択範囲から作る Wiki ページの下書き（#121）。 */
export type PageDraft = { title: string; body: string };

/** タイトルにする選択範囲の長さの上限。 */
const TITLE_MAX = 40;

/** 1 行で短い選択はタイトルに、それ以外は本文に入れる。 */
export const pageDraftFromSelection = (text: string): PageDraft => {
  const trimmed = text.trim();
  return !trimmed.includes("\n") && trimmed.length <= TITLE_MAX
    ? { title: trimmed, body: "" }
    : { title: "", body: trimmed };
};
