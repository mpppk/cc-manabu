/** コマンドパレット（#243）の 1 つの操作。 */
export type PaletteCommand = {
  id: string;
  label: string;
  /** 操作名のほかに、絞り込みで当てる語（別の言い方・英語）。 */
  keywords: readonly string[];
  /** 右端に出すショートカット。 */
  shortcut?: string;
  run: () => void;
};

const normalize = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/**
 * 入力した語句で操作を絞り込む。空白で区切った語句をすべて含む操作を、
 * 操作名に含むもの → 別の言い方に含むものの順に、元の並びを保って返す。
 */
export const filterCommands = <T extends PaletteCommand>(
  commands: readonly T[],
  query: string,
): T[] => {
  const terms = query
    .split(/\s+/)
    .map(normalize)
    .filter((t) => t !== "");
  if (terms.length === 0) return [...commands];
  const inLabel: T[] = [];
  const inKeywords: T[] = [];
  for (const command of commands) {
    const label = normalize(command.label);
    const all = [label, ...command.keywords.map(normalize)].join(" ");
    if (!terms.every((term) => all.includes(term))) continue;
    (terms.every((term) => label.includes(term)) ? inLabel : inKeywords).push(
      command,
    );
  }
  return [...inLabel, ...inKeywords];
};
