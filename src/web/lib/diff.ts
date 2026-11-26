/** 行ごとの差分の 1 行。 */
export type DiffLine = { type: "same" | "add" | "remove"; text: string };

/** これより大きいと LCS の表が大きくなりすぎるので、まとめて削除・追加として出す。 */
const MAX_CELLS = 4_000_000;

/**
 * 2 つの文字列の行ごとの差分（最長共通部分列）。Wiki の版の比較に使う（#166）。
 * 前後の同じ行は先に取り除いてから比べる。
 */
export const lineDiff = (before: string, after: string): DiffLine[] => {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a
    .slice(0, start)
    .map((text): DiffLine => ({ type: "same", text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ type: "same", text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) {
    return [
      ...head,
      ...midA.map((text): DiffLine => ({ type: "remove", text })),
      ...midB.map((text): DiffLine => ({ type: "add", text })),
      ...tail,
    ];
  }
  // lengths[i][j]: midA[i..] と midB[j..] の最長共通部分列の長さ
  const width = midB.length + 1;
  const lengths = new Uint32Array((midA.length + 1) * width);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        midA[i] === midB[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              lengths[(i + 1) * width + j] ?? 0,
              lengths[i * width + j + 1] ?? 0,
            );
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      middle.push({ type: "same", text: midA[i] as string });
      i++;
      j++;
    } else if (
      (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)
    ) {
      middle.push({ type: "remove", text: midA[i] as string });
      i++;
    } else {
      middle.push({ type: "add", text: midB[j] as string });
      j++;
    }
  }
  for (; i < midA.length; i++) {
    middle.push({ type: "remove", text: midA[i] as string });
  }
  for (; j < midB.length; j++) {
    middle.push({ type: "add", text: midB[j] as string });
  }
  return [...head, ...middle, ...tail];
};
