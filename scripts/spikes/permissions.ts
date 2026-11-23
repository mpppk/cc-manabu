#!/usr/bin/env bun
/**
 * Spike #14: canUseTool と settings.json の permission ルールの評価順を確認する。
 * 実機の claude を使う（サブスクの利用枠を少し消費する）。
 *
 *   bun scripts/spikes/permissions.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CanUseTool,
  type Options,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

type Outcome = {
  canUseToolCalls: string[];
  toolResults: { isError: boolean; content: string }[];
  denials: unknown;
  text: string;
  error?: string;
  elapsedMs: number;
};

const run = async (
  prompt: string,
  options: Options,
  decide: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<boolean>,
): Promise<Outcome> => {
  const outcome: Outcome = {
    canUseToolCalls: [],
    toolResults: [],
    denials: undefined,
    text: "",
    elapsedMs: 0,
  };
  const canUseTool: CanUseTool = async (toolName, input) => {
    outcome.canUseToolCalls.push(
      `${toolName} ${JSON.stringify(input.command ?? input.file_path ?? "")}`,
    );
    return (await decide(toolName, input))
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "ユーザーが拒否しました" };
  };
  const started = Date.now();
  try {
    for await (const m of query({
      prompt,
      options: { ...options, canUseTool },
    }) as AsyncIterable<SDKMessage>) {
      if (m.type === "user" && Array.isArray(m.message.content)) {
        for (const block of m.message.content) {
          if (block.type === "tool_result") {
            outcome.toolResults.push({
              isError: block.is_error === true,
              content: JSON.stringify(block.content).slice(0, 120),
            });
          }
        }
      }
      if (m.type === "result") {
        outcome.denials = m.permission_denials;
        outcome.text = m.subtype === "success" ? m.result : m.subtype;
      }
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  outcome.elapsedMs = Date.now() - started;
  return outcome;
};

const main = async () => {
  const claudePath = Bun.which("claude");
  if (claudePath === null) {
    throw new Error("claude が見つかりません");
  }
  const cwd = await mkdtemp(path.join(tmpdir(), "cc-manabu-perm-"));
  await mkdir(path.join(cwd, ".claude"), { recursive: true });
  await writeFile(
    path.join(cwd, ".claude", "settings.json"),
    JSON.stringify(
      {
        permissions: {
          allow: ["Bash(touch allowed.txt)"],
          deny: ["Bash(touch denied.txt)"],
        },
      },
      null,
      2,
    ),
  );
  const base: Options = {
    cwd,
    model: "haiku",
    pathToClaudeCodeExecutable: claudePath,
    settingSources: ["project"],
    tools: ["Bash", "Write", "Read"],
    maxTurns: 4,
  };
  const once = (command: string) =>
    `Bash ツールで \`${command}\` を一度だけ実行してください。結果に関わらず、その後は何もせず「完了」とだけ返してください。`;

  const scenarios: [string, () => Promise<Outcome>][] = [
    [
      "settings.json で allow 済みのコマンド",
      () => run(once("touch allowed.txt"), base, async () => false),
    ],
    [
      "settings.json で deny 済みのコマンド",
      () => run(once("touch denied.txt"), base, async () => true),
    ],
    [
      "SDK の allowedTools で allow 済みのコマンド",
      () =>
        run(
          once("touch allowed.txt"),
          { ...base, allowedTools: ["Bash(touch allowed.txt)"] },
          async () => false,
        ),
    ],
    [
      "ルールに無いコマンド（canUseTool で許可）",
      () => run(once("touch other.txt"), base, async () => true),
    ],
    [
      "ルールに無いコマンド（canUseTool が 90 秒待ってから許可）",
      () =>
        run(once("touch slow.txt"), base, async () => {
          await Bun.sleep(90_000);
          return true;
        }),
    ],
    [
      "permissionMode: acceptEdits で Write",
      () =>
        run(
          "Write ツールで note.txt に hello と書いてください。その後「完了」とだけ返してください。",
          { ...base, permissionMode: "acceptEdits" },
          async () => false,
        ),
    ],
  ];

  try {
    for (const [label, scenario] of scenarios) {
      const outcome = await scenario();
      console.log(`\n## ${label}\n${JSON.stringify(outcome, null, 2)}`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

await main();
