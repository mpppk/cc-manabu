/**
 * 実機の Haiku で、環境の説明による用語抽出の絞り込み（#160）を確かめる。CI では実行しない。
 *
 *   bun run test:live
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateText } from "ai";
import { createClaudeCode } from "../../src/provider/index.ts";
import {
  buildTermExtractionPrompt,
  parseTermCandidates,
  TERM_EXTRACTION_MODEL,
  TERM_EXTRACTION_SETTINGS,
} from "../../src/wiki/terms.ts";

const LIVE = process.env.MONET_LIVE === "1";

const question = "仮名加工情報を社内の分析に使うときの注意点を、資料にまとめて";
const answer = [
  "仮名加工情報は、他の情報と照合しない限り特定の個人を識別できないように加工した個人情報です。",
  "社内の分析に使う場合は、利用目的の公表と、削除情報等の安全管理措置が必要です。",
  "第三者提供は原則としてできません。",
  "まとめた資料は Claude Artifact で表として作成しました。",
].join("\n");

describe.skipIf(!LIVE)("live: 用語抽出", () => {
  test("環境の説明に沿った語を選び、資料作成の道具として触れた語は外す", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cc-manabu-live-"));
    const model = createClaudeCode({
      cwd,
      pathToClaudeCodeExecutable: Bun.which("claude") ?? undefined,
      ...TERM_EXTRACTION_SETTINGS,
    })(TERM_EXTRACTION_MODEL);
    const { text } = await generateText({
      model,
      prompt: buildTermExtractionPrompt({
        question,
        answer,
        existing: [],
        description: "個人情報の取扱いを検討する",
      }),
    });
    const terms = parseTermCandidates(text, { answer, existing: [] }).map(
      (candidate) => candidate.term,
    );
    expect(terms).toContain("仮名加工情報");
    expect(terms).not.toContain("Claude Artifact");
  }, 120_000);
});
