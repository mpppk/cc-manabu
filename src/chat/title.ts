/** タイトルの最大の長さ（文字数。サロゲートペアは 1 文字と数える）。 */
export const TITLE_MAX_LENGTH = 40;

/**
 * 最初の発話から会話のタイトルを作る。
 * サブスクの利用枠を使わず即座に決まるよう、モデルで要約せず先頭を切り出す（#31）。
 */
export const makeTitle = (text: string): string => {
  const normalized = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...normalized];
  if (chars.length === 0) {
    return "新しい会話";
  }
  return chars.length > TITLE_MAX_LENGTH
    ? `${chars.slice(0, TITLE_MAX_LENGTH - 1).join("")}…`
    : normalized;
};
