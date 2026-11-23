import { describe, expect, test } from "bun:test";
import {
  buildTermExtractionPrompt,
  MAX_NEW_TERMS,
  normalizeTerm,
  parseTermCandidates,
} from "../../src/wiki/terms.ts";

const answer =
  "関係タプル（relation tuple）は OpenFGA の基本単位です。認可モデルで型を定義します。";

describe("parseTermCandidates", () => {
  test("JSON の配列（コードブロックでも）を候補にする", () => {
    const output = `\`\`\`json
[{"term": "関係タプル", "aliases": ["relation tuple", ""], "summary": "3 つ組。"}]
\`\`\``;
    expect(parseTermCandidates(output, { answer, existing: [] })).toEqual([
      { term: "関係タプル", aliases: ["relation tuple"], summary: "3 つ組。" },
    ]);
  });

  test("回答に出てこない語・既存の語・別名と重なる語・壊れた要素は捨てる", () => {
    const output = JSON.stringify([
      { term: "回答にない語", aliases: [], summary: "x" },
      { term: "ＯｐｅｎＦＧＡ", aliases: [], summary: "既存" },
      { term: "認可モデル", aliases: ["openfga"], summary: "型の定義" },
      { term: "関係タプル", summary: "" },
      { term: 1, summary: "x" },
      "文字列",
    ]);
    expect(
      parseTermCandidates(output, { answer, existing: ["OpenFGA"] }),
    ).toEqual([{ term: "認可モデル", aliases: [], summary: "型の定義" }]);
  });

  test(`多くても ${MAX_NEW_TERMS} 件で、同じ語は 1 回だけ`, () => {
    const terms = [
      "関係タプル",
      "関係タプル",
      "OpenFGA",
      "認可モデル",
      "基本単位",
    ];
    const output = JSON.stringify(
      terms.map((term) => ({ term, aliases: [], summary: "s" })),
    );
    const result = parseTermCandidates(output, { answer, existing: [] });
    expect(result.map((c) => c.term)).toEqual([
      "関係タプル",
      "OpenFGA",
      "認可モデル",
    ]);
  });

  test("JSON でなければ空", () => {
    expect(parseTermCandidates("該当なし", { answer, existing: [] })).toEqual(
      [],
    );
    expect(parseTermCandidates("[", { answer, existing: [] })).toEqual([]);
  });
});

test("normalizeTerm は全角半角・大文字小文字・空白を揃える", () => {
  expect(normalizeTerm(" Relation　Tuple ")).toBe("relation tuple");
  expect(normalizeTerm("ＯｐｅｎＦＧＡ")).toBe("openfga");
});

test("抽出のプロンプトに既存の語・質問・回答を区切って入れる", () => {
  const prompt = buildTermExtractionPrompt({
    question: "Q",
    answer: "A",
    existing: ["x", "y"],
  });
  expect(prompt).toContain("<existing-terms>\nx\ny\n</existing-terms>");
  expect(prompt).toContain("<question>\nQ\n</question>");
  expect(prompt).toContain("<answer>\nA\n</answer>");
});
