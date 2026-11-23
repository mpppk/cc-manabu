#!/usr/bin/env bun
/**
 * Spike (#80): 回答から用語を取り出す追加の呼び出しを、どれだけ軽くできるか。
 * claude_code のシステムプロンプトとツールを外し（systemPrompt を文字列で置き換え、tools: []）、
 * セッションを保存しない（persistSession: false）設定で、入力トークンと出力を確かめる。
 *
 *   bun scripts/spikes/term-extraction.ts
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  buildTermExtractionPrompt,
  parseTermCandidates,
  TERM_EXTRACTION_SYSTEM_PROMPT,
} from "../../src/wiki/terms.ts";

const answer = [
  "関係タプル（relation tuple）は、OpenFGA で権限を表す (主体, 関係, 対象) の 3 つ組です。",
  "例えば `user:alice viewer document:1` は「alice は document:1 の viewer」という意味です。",
  "認可モデルでは、型と関係を DSL で定義し、チェック API で関係タプルをたどって判定します。",
].join("\n");
const input = {
  question: "OpenFGA の関係タプルって何？",
  answer,
  existing: ["OpenFGA"],
};

const cwd = await mkdtemp(path.join(tmpdir(), "spike-terms-"));
const projectsDir = path.join(process.env.HOME ?? "", ".claude", "projects");
const before = new Set(await readdir(projectsDir).catch(() => []));
try {
  let text = "";
  let usage: Record<string, number> = {};
  let cost = 0;
  for await (const m of query({
    prompt: buildTermExtractionPrompt(input),
    options: {
      cwd,
      model: "haiku",
      systemPrompt: TERM_EXTRACTION_SYSTEM_PROMPT,
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      thinking: { type: "disabled" },
    },
  })) {
    if (m.type === "assistant") {
      for (const block of m.message.content) {
        if (block.type === "text") text += block.text;
      }
    }
    if (m.type === "result") {
      usage = m.usage as unknown as Record<string, number>;
      cost = m.total_cost_usd;
    }
  }
  console.log("output:", text);
  console.log("usage:", {
    input: usage.input_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheCreation: usage.cache_creation_input_tokens,
    output: usage.output_tokens,
    costUsd: cost,
  });
  console.log("candidates:", parseTermCandidates(text, input));
  const after = await readdir(projectsDir).catch(() => []);
  console.log(
    "new session dirs:",
    after.filter((dir) => !before.has(dir)),
  );
} finally {
  await rm(cwd, { recursive: true, force: true });
}
