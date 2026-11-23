#!/usr/bin/env bun
/**
 * Spike #13: resume / resumeSessionAt / forkSession の挙動を確認する。
 * 実機の claude を使う（サブスクの利用枠を少し消費する）。結果は標準出力に出す。
 *
 *   bun scripts/spikes/session-branching.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  deleteSession,
  getSessionMessages,
  type Options,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

type Turn = {
  sessionId: string;
  text: string;
  assistantUuids: string[];
  userUuids: string[];
  error?: string;
};

const run = async (
  prompt: string,
  options: Options,
  abortAfterFirstDelta = false,
): Promise<Turn> => {
  const abortController = new AbortController();
  const turn: Turn = {
    sessionId: "",
    text: "",
    assistantUuids: [],
    userUuids: [],
  };
  try {
    for await (const m of query({
      prompt,
      options: { ...options, abortController },
    }) as AsyncIterable<SDKMessage>) {
      if (abortController.signal.aborted) {
        continue;
      }
      if ("session_id" in m && typeof m.session_id === "string") {
        turn.sessionId = m.session_id;
      }
      if (m.type === "assistant") {
        turn.assistantUuids.push(m.uuid);
      }
      if (m.type === "user" && "uuid" in m && typeof m.uuid === "string") {
        turn.userUuids.push(m.uuid);
      }
      if (m.type === "stream_event" && m.event.type === "content_block_delta") {
        if (m.event.delta.type === "text_delta") {
          turn.text += m.event.delta.text;
        }
        if (abortAfterFirstDelta) {
          abortController.abort();
        }
      }
    }
  } catch (error) {
    turn.error = error instanceof Error ? error.message : String(error);
  }
  return turn;
};

const log = (label: string, turn: Turn) => {
  console.log(
    `\n## ${label}\n- session: ${turn.sessionId}\n- text: ${JSON.stringify(turn.text.slice(0, 80))}\n- assistant uuids: ${turn.assistantUuids.join(", ")}\n- user uuids (echoed): ${turn.userUuids.join(", ") || "(none)"}${turn.error ? `\n- error: ${turn.error}` : ""}`,
  );
};

const dumpSession = async (label: string, sessionId: string, cwd: string) => {
  const messages = await getSessionMessages(sessionId, { dir: cwd });
  console.log(`\n### getSessionMessages(${label})`);
  for (const m of messages) {
    const content = (m.message as { content?: unknown }).content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((b: { type: string; text?: string }) =>
                b.type === "text" ? b.text : `[${b.type}]`,
              )
              .join("")
          : "";
    console.log(`- ${m.type} ${m.uuid}: ${JSON.stringify(text.slice(0, 60))}`);
  }
};

const main = async () => {
  const claudePath = Bun.which("claude");
  if (claudePath === null) {
    throw new Error("claude が見つかりません");
  }
  const cwd = await mkdtemp(path.join(tmpdir(), "cc-manabu-spike-"));
  const base: Options = {
    cwd,
    model: "haiku",
    pathToClaudeCodeExecutable: claudePath,
    settingSources: [],
    tools: [],
    includePartialMessages: true,
  };
  const created: string[] = [];

  try {
    const t1 = await run(
      "合言葉は「りんご」です。「OK」とだけ返してください。",
      base,
    );
    log("turn1（新規）", t1);
    created.push(t1.sessionId);

    const t2 = await run(
      "合言葉を「みかん」に変更します。「OK」とだけ返してください。",
      { ...base, resume: t1.sessionId },
    );
    log("turn2（resume）", t2);
    await dumpSession("turn2 後の元セッション", t1.sessionId, cwd);

    // turn2 をやり直す（= 編集 / 再生成）: turn1 の最後の assistant まで巻き戻して fork
    const fork = await run("今の合言葉を単語だけで返してください。", {
      ...base,
      resume: t1.sessionId,
      resumeSessionAt: t1.assistantUuids.at(-1),
      forkSession: true,
    });
    log("fork（turn1 の直後から分岐）", fork);
    created.push(fork.sessionId);
    await dumpSession("fork 後の分岐先", fork.sessionId, cwd);

    const original = await run("今の合言葉を単語だけで返してください。", {
      ...base,
      resume: t1.sessionId,
    });
    log("元セッションを resume（分岐元が壊れていないか）", original);

    const aborted = await run(
      "1 から 400 までの数字を 1 行に 1 つずつ書いてください。",
      { ...base, resume: t1.sessionId },
      true,
    );
    log("中断したターン", aborted);
    await dumpSession("中断後の元セッション", t1.sessionId, cwd);

    const afterAbort = await run(
      "直前のあなたの返答はどこまで書かれていましたか？最後の数字だけ返してください。返答が無ければ「なし」と返してください。",
      { ...base, resume: t1.sessionId },
    );
    log("中断後に resume", afterAbort);
  } finally {
    for (const id of created) {
      await deleteSession(id, { dir: cwd }).catch(() => {});
    }
    await rm(cwd, { recursive: true, force: true });
  }
};

await main();
