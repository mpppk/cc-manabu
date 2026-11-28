import { describe, expect, test } from "bun:test";
import type {
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { streamText } from "ai";
import { toContextUsage } from "../../src/chat/context-usage.ts";
import { createClaudeCode } from "../../src/provider/index.ts";
import type { QueryFunction } from "../../src/provider/types.ts";
import { loadFixture } from "./fake-query.ts";

const usage = {
  categories: [
    {
      id: "system_prompt",
      name: "System prompt",
      tokens: 3000,
      color: "",
      kind: "used",
    },
    { id: "messages", name: "Messages", tokens: 2000, color: "", kind: "used" },
    {
      id: "mcp_tools_deferred",
      name: "MCP tools",
      tokens: 0,
      color: "",
      kind: "deferred",
    },
    {
      id: "free_space",
      name: "Free space",
      tokens: 195000,
      color: "",
      kind: "free",
    },
  ],
  totalTokens: 5000,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 2.5,
  gridRows: [],
  model: "claude-haiku",
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  isAutoCompactEnabled: true,
  apiUsage: null,
} as SDKControlGetContextUsageResponse;

/**
 * 実物のように、入力の最初の発話を読んでから fixture を流し、入力が閉じるまで終わらない query()。
 * getContextUsage は入力が開いている間だけ答える。
 */
const setup = async (
  respond: () => Promise<SDKControlGetContextUsageResponse>,
) => {
  const lines = (await loadFixture("text-partial")) as SDKMessage[];
  const prompts: unknown[] = [];
  let inputOpen = false;
  const usageCalls: unknown[] = [];
  const query: QueryFunction = ({ prompt }) => {
    let drained: Promise<void> = Promise.resolve();
    const generator = (async function* () {
      if (typeof prompt === "string") {
        prompts.push(prompt);
      } else {
        const iterator = prompt[Symbol.asyncIterator]();
        const first = await iterator.next();
        prompts.push((first.value as SDKUserMessage).message.content);
        inputOpen = true;
        drained = (async () => {
          while (!(await iterator.next()).done) {
            // 次の発話は来ない
          }
          inputOpen = false;
        })();
      }
      for (const line of lines) {
        await Promise.resolve();
        yield line;
      }
      await drained;
    })();
    return Object.assign(generator, {
      getContextUsage: async (opts: unknown) => {
        usageCalls.push(opts);
        if (!inputOpen) throw new Error("input closed");
        return respond();
      },
    }) as unknown as ReturnType<QueryFunction>;
  };
  const received: SDKControlGetContextUsageResponse[] = [];
  const model = createClaudeCode({
    cwd: "/work",
    query,
    onContextUsage: (u) => received.push(u),
  })("haiku");
  return { model, prompts, received, usageCalls };
};

describe("コンテキストの使用量（#245）", () => {
  test("回答のあと、入力を開けたまま summary で取り、取り終えたら入力を閉じる", async () => {
    const { model, prompts, received, usageCalls } = await setup(
      async () => usage,
    );
    await streamText({ model, prompt: "こんにちは" }).consumeStream();
    expect(prompts).toEqual(["こんにちは"]);
    expect(usageCalls).toEqual([{ detail: "summary" }]);
    expect(received).toEqual([usage]);
  });

  test("スラッシュコマンドでは取らない（入力はそのまま渡す）", async () => {
    const { model, prompts, usageCalls } = await setup(async () => usage);
    await streamText({ model, prompt: "/goal テスト" }).consumeStream();
    expect(prompts).toEqual(["/goal テスト"]);
    expect(usageCalls).toEqual([]);
  });

  test("取れなくても回答は終わる", async () => {
    const { model, received } = await setup(async () => {
      throw new Error("not supported");
    });
    const result = streamText({ model, prompt: "こんにちは" });
    await result.consumeStream();
    expect(await result.text).not.toBe("");
    expect(received).toEqual([]);
  });
});

describe("toContextUsage（#245）", () => {
  test("いまの使用量と上限から割合を出し、表示に使うカテゴリだけを残す", () => {
    const now = new Date("2026-11-28T00:00:00Z");
    expect(toContextUsage(usage, now)).toEqual({
      totalTokens: 5000,
      maxTokens: 200000,
      percentage: 2.5,
      model: "claude-haiku",
      categories: [
        {
          id: "system_prompt",
          name: "System prompt",
          tokens: 3000,
          kind: "used",
        },
        { id: "messages", name: "Messages", tokens: 2000, kind: "used" },
        { id: "free_space", name: "Free space", tokens: 195000, kind: "free" },
      ],
      capturedAt: "2026-11-28T00:00:00.000Z",
    });
  });
});
