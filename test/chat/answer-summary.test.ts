import { describe, expect, test } from "bun:test";
import {
  buildAnswerSummaryPrompt,
  MAX_ANSWER_SUMMARY_LENGTH,
  parseAnswerSummary,
} from "../../src/chat/answer-summary.ts";

describe("parseAnswerSummary", () => {
  test("前後の空白を落として、そのまま要約にする", () => {
    expect(
      parseAnswerSummary("  関係タプルは主体・関係・対象の 3 つ組。\n"),
    ).toBe("関係タプルは主体・関係・対象の 3 つ組。");
  });

  test("複数行は 1 行にまとめ、Markdown の記号と前置きを落とす", () => {
    expect(
      parseAnswerSummary("要約: **認可**の仕組みを説明。\n- 例も示した。"),
    ).toBe("認可の仕組みを説明。 例も示した。");
    expect(parseAnswerSummary("## まとめ\n`RTP` で音声を送る。")).toBe(
      "まとめ RTP で音声を送る。",
    );
  });

  test("全体を囲む引用符を外す", () => {
    expect(parseAnswerSummary("「SIP で通話を確立する。」")).toBe(
      "SIP で通話を確立する。",
    );
  });

  test("長すぎる要約は切る", () => {
    const summary = parseAnswerSummary("あ".repeat(300));
    expect(summary).toBe(`${"あ".repeat(MAX_ANSWER_SUMMARY_LENGTH)}…`);
  });

  test("空・コードブロックだけなら使わない", () => {
    expect(parseAnswerSummary("")).toBeUndefined();
    expect(parseAnswerSummary("```\nconst a = 1;\n```")).toBeUndefined();
  });
});

describe("buildAnswerSummaryPrompt", () => {
  test("質問と回答をタグで囲んで渡す", () => {
    const prompt = buildAnswerSummaryPrompt({
      question: "RTP とは",
      answer: "音声を運ぶプロトコルです。",
    });
    expect(prompt).toContain("<answer-summary>");
    expect(prompt).toContain("<question>\nRTP とは\n</question>");
    expect(prompt).toContain("<answer>\n音声を運ぶプロトコルです。\n</answer>");
  });

  test("長い回答は切って渡す", () => {
    const prompt = buildAnswerSummaryPrompt({
      question: "q",
      answer: "あ".repeat(20_000),
    });
    expect(prompt.length).toBeLessThan(10_000);
  });
});
