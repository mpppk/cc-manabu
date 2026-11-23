#!/usr/bin/env bun
/**
 * Spike #11: bun build --compile したバイナリから Agent SDK の query() を呼べるか確認する。
 *
 *   bun build --compile scripts/spikes/compile-agent-sdk.ts --outfile /tmp/agent-sdk-spike
 *   /tmp/agent-sdk-spike [path-to-claude]
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

const claudePath = process.argv[2] ?? Bun.which("claude") ?? undefined;
console.log(`execPath: ${process.execPath}`);
console.log(`pathToClaudeCodeExecutable: ${claudePath ?? "(SDK の既定)"}`);

const started = Date.now();
for await (const m of query({
  prompt: "「pong」とだけ返してください。",
  options: {
    model: "haiku",
    settingSources: [],
    tools: [],
    ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
  },
})) {
  if (m.type === "system" && m.subtype === "init") {
    console.log(`init: model=${m.model}`);
  }
  if (m.type === "result") {
    console.log(
      `result: ${m.subtype} ${m.subtype === "success" ? m.result : ""} (${Date.now() - started}ms)`,
    );
  }
}
