#!/usr/bin/env bun
/**
 * Spike (#198): Agent SDK の query() でネイティブの `/goal` を起動できるか。
 * 達成・達成不能が、どのメッセージ（SDK のイベント）やセッションの記録に出るかを確かめる。
 *
 * 1. すぐ達成できるゴール
 * 2. 達成できないゴール
 *
 * 実機の claude を使う（サブスクの利用枠を少し消費する）。1 回あたり 2 分で打ち切る。
 *
 *   bun scripts/spikes/goal.ts
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const findTranscript = async (sessionId: string) => {
  const root = path.join(homedir(), ".claude", "projects");
  for (const dir of await readdir(root)) {
    const file = path.join(root, dir, `${sessionId}.jsonl`);
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text !== undefined) return text;
  }
  return undefined;
};

const run = async (label: string, condition: string) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cc-manabu-goal-"));
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 120_000);
  let sessionId = "";
  console.log(`\n===== ${label}: /goal ${condition}`);
  try {
    for await (const m of query({
      prompt: `/goal ${condition}`,
      options: {
        cwd,
        model: "haiku",
        abortController,
        permissionMode: "default",
        canUseTool: async () => ({
          behavior: "deny",
          message: "このスパイクではツールを使わない",
        }),
      },
    })) {
      const record = m as Record<string, unknown>;
      if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
      const summary: Record<string, unknown> = {
        type: m.type,
        subtype: record.subtype,
      };
      if (m.type === "assistant") {
        summary.text = m.message.content
          .flatMap((c) => (c.type === "text" ? [c.text.slice(0, 200)] : []))
          .join(" ");
      } else if (m.type === "result") {
        summary.result = (record.result as string | undefined)?.slice(0, 300);
        summary.stop_reason = record.stop_reason;
        summary.num_turns = record.num_turns;
        summary.is_error = record.is_error;
      } else if (m.type === "system" && m.subtype !== "init") {
        summary.raw = JSON.stringify(m).slice(0, 600);
      } else if (m.type === "user") {
        summary.raw = JSON.stringify(m.message).slice(0, 300);
      }
      console.log(JSON.stringify(summary));
    }
  } catch (error) {
    console.log("error:", error);
  } finally {
    clearTimeout(timer);
  }
  const transcript = await findTranscript(sessionId);
  console.log(`--- transcript (${sessionId}): goal に関する行`);
  for (const line of transcript?.split("\n") ?? []) {
    if (/goal|achieved|impossible|Stop hook|stop_hook/i.test(line)) {
      console.log(line.slice(0, 800));
    }
  }
  await rm(cwd, { recursive: true, force: true });
};

const which = process.argv[2] ?? "all";
if (which === "all" || which === "achievable") {
  await run(
    "achievable",
    "あなたの直前の返答に「完了しました」という文字列が含まれている",
  );
}
if (which === "all" || which === "impossible") {
  await run(
    "impossible",
    "ペアノの公理のもとで 2 + 2 = 5 が成り立つことを、誤りのない証明で示した",
  );
}
