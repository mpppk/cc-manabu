#!/usr/bin/env bun
/**
 * 実機の Agent SDK `query()` が返す SDKMessage 列を JSONL で記録し、Provider の単体テスト用の fixture を作る。
 *
 * 使い方:
 *   bun scripts/record-sdk-messages.ts [scenario...]
 *
 * 前提: `claude` がインストールされてログイン済みであること。サブスクリプションの利用枠を少し消費する。
 * 出力: test/fixtures/sdk-messages/<scenario>.jsonl（パスやアカウント情報は伏せ字にする）
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Options,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

const FIXTURE_DIR = path.join(
  import.meta.dir,
  "..",
  "test",
  "fixtures",
  "sdk-messages",
);
const MODEL = process.env.RECORD_MODEL ?? "haiku";

type Scenario = {
  description: string;
  run: (ctx: Context) => Promise<SDKMessage[]>;
};

type Context = {
  cwd: string;
  baseOptions: Options;
};

const collect = async (
  prompt: string,
  options: Options,
  onMessage?: (message: SDKMessage, controller: AbortController) => void,
): Promise<SDKMessage[]> => {
  const abortController = options.abortController ?? new AbortController();
  const messages: SDKMessage[] = [];
  try {
    for await (const message of query({
      prompt,
      options: { ...options, abortController },
    })) {
      messages.push(message);
      onMessage?.(message, abortController);
    }
  } catch (error) {
    // 中断などで投げられた例外も記録しておく
    messages.push({
      type: "__error__",
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    } as unknown as SDKMessage);
  }
  return messages;
};

const sessionIdOf = (messages: SDKMessage[]): string | undefined =>
  messages.find((m) => m.type === "result")?.session_id;

const scenarios: Record<string, Scenario> = {
  "text-partial": {
    description: "テキストのみ（includePartialMessages: true）",
    run: ({ baseOptions }) =>
      collect("「こんにちは」と一言だけ返してください。", {
        ...baseOptions,
        includePartialMessages: true,
      }),
  },
  "text-no-partial": {
    description: "テキストのみ（includePartialMessages: false）",
    run: ({ baseOptions }) =>
      collect("「こんにちは」と一言だけ返してください。", baseOptions),
  },
  thinking: {
    description: "thinking あり（thinking: enabled, display: summarized）",
    run: ({ baseOptions }) =>
      collect(
        "3 人（A, B, C）のうち 1 人だけが嘘をついています。A「B は嘘つき」、B「C は嘘つき」、C「A と B は正直」。嘘つきは誰ですか？名前だけ返してください。",
        {
          ...baseOptions,
          includePartialMessages: true,
          effort: "high",
          thinking: {
            type: "enabled",
            budgetTokens: 2048,
            display: "summarized",
          },
        },
      ),
  },
  "tool-read": {
    description: "読み取り系ツール（Read を自動許可）",
    run: ({ baseOptions, cwd }) =>
      collect(
        `${path.join(cwd, "hello.txt")} を Read ツールで読み、中身をそのまま返してください。`,
        {
          ...baseOptions,
          includePartialMessages: true,
          tools: ["Read"],
          allowedTools: ["Read"],
        },
      ),
  },
  "tool-error": {
    description: "ツールのエラー（存在しないファイルを Read）",
    run: ({ baseOptions, cwd }) =>
      collect(
        `${path.join(cwd, "missing.txt")} を Read ツールで一度だけ読んでください。失敗したら「失敗」とだけ返してください。`,
        {
          ...baseOptions,
          includePartialMessages: true,
          tools: ["Read"],
          allowedTools: ["Read"],
        },
      ),
  },
  "tool-permission-deny": {
    description: "承認が必要なツール（canUseTool で Bash を拒否）",
    run: ({ baseOptions }) =>
      collect(
        "Bash ツールで `touch created.txt` を一度だけ実行してください。拒否されたら「拒否」とだけ返してください。",
        {
          ...baseOptions,
          includePartialMessages: true,
          tools: ["Bash"],
          canUseTool: async (toolName, input, options) => {
            canUseToolCalls.push({
              toolName,
              input,
              options: { ...options, signal: undefined },
            });
            return {
              behavior: "deny",
              message: `${toolName} はユーザーに拒否されました`,
            };
          },
        },
      ),
  },
  "tool-permission-allow": {
    description: "承認が必要なツール（canUseTool で Bash を許可）",
    run: ({ baseOptions }) =>
      collect(
        "Bash ツールで `touch created.txt && ls` を一度だけ実行し、出力をそのまま返してください。",
        {
          ...baseOptions,
          includePartialMessages: true,
          tools: ["Bash"],
          canUseTool: async (toolName, input, options) => {
            canUseToolCalls.push({
              toolName,
              input,
              options: { ...options, signal: undefined },
            });
            return { behavior: "allow", updatedInput: input };
          },
        },
      ),
  },
  abort: {
    description: "最初のテキスト delta の後に中断",
    run: ({ baseOptions }) => {
      let aborted = false;
      return collect(
        "1 から 400 までの数字を、1 行に 1 つずつ書いてください。",
        { ...baseOptions, includePartialMessages: true },
        (message, controller) => {
          if (
            !aborted &&
            message.type === "stream_event" &&
            message.event.type === "content_block_delta"
          ) {
            aborted = true;
            controller.abort();
          }
        },
      );
    },
  },
  resume: {
    description: "resume で 2 ターン目（1 ターン目は resume-turn1）",
    run: async ({ baseOptions }) => {
      const turn1 = await collect(
        "合言葉は「りんご」です。覚えたら「OK」とだけ返してください。",
        { ...baseOptions, includePartialMessages: true },
      );
      await save("resume-turn1", turn1);
      const sessionId = sessionIdOf(turn1);
      if (sessionId === undefined) {
        throw new Error("turn1 で session_id を取得できませんでした");
      }
      return collect("合言葉は何でしたか？単語だけ返してください。", {
        ...baseOptions,
        includePartialMessages: true,
        resume: sessionId,
      });
    },
  },
};

const redact = (value: unknown, replacements: [string, string][]): unknown => {
  if (typeof value === "string") {
    return replacements.reduce(
      (text, [from, to]) => text.split(from).join(to),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, replacements));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        REDACTED_KEYS.has(key) ? "<redacted>" : redact(item, replacements),
      ]),
    );
  }
  return value;
};

/** アカウントや環境に依存する値を持つキー。値ごと伏せる。 */
const REDACTED_KEYS = new Set([
  "email",
  "account",
  "organization",
  "accountUuid",
  "organizationUuid",
  "apiKeySource",
  "mcp_servers",
  "plugins",
  "skills",
  "slash_commands",
  "agents",
  "memory_paths",
  "claude_code_version",
]);

let replacements: [string, string][] = [];

/** canUseTool に渡された引数。permissions の検証（#14）の材料として別ファイルに保存する。 */
const canUseToolCalls: unknown[] = [];

/** system/init は実行環境に依存する値が多いので、Provider が使うキーだけ残す。 */
const INIT_KEYS = [
  "type",
  "subtype",
  "cwd",
  "session_id",
  "tools",
  "model",
  "permissionMode",
  "output_style",
  "uuid",
];

const normalize = (message: SDKMessage): unknown => {
  if (message.type === "system" && message.subtype === "init") {
    return Object.fromEntries(
      Object.entries(message).filter(([key]) => INIT_KEYS.includes(key)),
    );
  }
  return message;
};

const save = async (name: string, messages: SDKMessage[]): Promise<void> => {
  const lines = messages.map((m) =>
    JSON.stringify(redact(normalize(m), replacements)),
  );
  await writeFile(
    path.join(FIXTURE_DIR, `${name}.jsonl`),
    `${lines.join("\n")}\n`,
  );
  console.log(`  -> ${name}.jsonl (${messages.length} messages)`);
};

const main = async () => {
  const selected = process.argv.slice(2);
  const names = selected.length > 0 ? selected : Object.keys(scenarios);
  const claudePath = Bun.which("claude");
  if (claudePath === null) {
    throw new Error("claude が見つかりません。インストールしてください。");
  }

  await mkdir(FIXTURE_DIR, { recursive: true });
  const cwd = await mkdtemp(path.join(tmpdir(), "cc-manabu-record-"));
  await writeFile(path.join(cwd, "hello.txt"), "Hello from cc-manabu!\n");
  replacements = [
    [cwd, "/tmp/cc-manabu-fixture"],
    [process.env.HOME ?? "/nonexistent-home", "/home/user"],
  ];

  const baseOptions: Options = {
    cwd,
    model: MODEL,
    pathToClaudeCodeExecutable: claudePath,
    settingSources: [],
    tools: [],
    maxTurns: 3,
  };

  try {
    for (const name of names) {
      const scenario = scenarios[name];
      if (scenario === undefined) {
        throw new Error(`不明なシナリオ: ${name}`);
      }
      console.log(`${name}: ${scenario.description}`);
      canUseToolCalls.length = 0;
      await save(name, await scenario.run({ cwd, baseOptions }));
      if (canUseToolCalls.length > 0) {
        await writeFile(
          path.join(FIXTURE_DIR, `${name}.can-use-tool.json`),
          `${JSON.stringify(redact(canUseToolCalls, replacements), null, 2)}\n`,
        );
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

await main();
