/**
 * 回答のパーツのうち、思考・ツールの実行が続くところを 1 つの「手順」のまとまりにする。
 * 本文や承認のカードなど、それ以外のパーツはそのまま 1 つずつ並べる。
 */
export type PartSegment<P> =
  | { kind: "single"; part: P; index: number }
  | { kind: "steps"; items: { part: P; index: number }[] };

export const groupSteps = <P>(
  parts: readonly P[],
  /** 手順（思考・ツールの実行）か。 */
  isStep: (part: P) => boolean,
  /** 表示しないパーツ（区切りにもしない）か。 */
  isSkipped: (part: P) => boolean,
): PartSegment<P>[] => {
  const segments: PartSegment<P>[] = [];
  let run: { part: P; index: number }[] = [];
  const flush = () => {
    const [only] = run;
    if (run.length === 1 && only !== undefined) {
      segments.push({ kind: "single", ...only });
    } else if (run.length > 1) {
      segments.push({ kind: "steps", items: run });
    }
    run = [];
  };
  parts.forEach((part, index) => {
    if (isSkipped(part)) return;
    if (isStep(part)) {
      run.push({ part, index });
      return;
    }
    flush();
    segments.push({ kind: "single", part, index });
  });
  flush();
  return segments;
};

/** 手順の内訳（「思考 2・Bash 3」のように、最初に出てきた順）。 */
export const describeSteps = (names: readonly string[]): string => {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name} ${count}`).join("・");
};
