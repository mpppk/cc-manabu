import { describe, expect, test } from "bun:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { streamText } from "ai";
import { probeCodex, toModelInfos } from "../../src/agents/status.ts";
import type { AppServerProcess } from "../../src/provider/codex/app-server.ts";
import { createCodex } from "../../src/provider/codex/codex-language-model.ts";

// biome-ignore lint/suspicious/noExplicitAny: 台本の JSON-RPC メッセージは形を決めずに扱う
type Json = any;
type Message = { id?: number; method?: string; params?: Json; result?: Json };

/**
 * 台本どおりに答える Codex App Server。requests に、受け取った問い合わせを残す。
 * onRequest で、問い合わせへの応答と、そのあとに送る通知・問い合わせを決める。
 */
const fakeAppServer = (
  onRequest: (
    message: Message,
    send: (message: Message) => void,
  ) => unknown | undefined,
) => {
  const requests: Message[] = [];
  const responses: Message[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  const exited = Promise.withResolvers<{ code: number; stderr: string }>();
  let killed = false;
  const send = (message: Message) => {
    if (killed) return;
    controller.enqueue(
      new TextEncoder().encode(`${JSON.stringify(message)}\n`),
    );
  };
  const process: AppServerProcess = {
    write: (line) => {
      const message = JSON.parse(line) as Message;
      if (message.method === undefined) {
        responses.push(message);
        return;
      }
      requests.push(message);
      if (message.id === undefined) return;
      const result =
        message.method === "initialize"
          ? { userAgent: "fake" }
          : onRequest(message, send);
      queueMicrotask(() => send({ id: message.id, result: result ?? {} }));
    },
    stdout,
    exited: exited.promise,
    kill: () => {
      if (killed) return;
      killed = true;
      controller.close();
      exited.resolve({ code: 0, stderr: "" });
    },
  };
  return { spawn: () => process, requests, responses };
};

const collect = async (
  model: ReturnType<ReturnType<typeof createCodex>>,
  providerOptions: Record<string, unknown> = {},
) => {
  const result = streamText({
    model,
    prompt: "こんにちは",
    includeRawChunks: true,
    providerOptions: { "claude-code": providerOptions as never },
  });
  const parts: { type: string; [key: string]: unknown }[] = [];
  for await (const part of result.fullStream) parts.push(part);
  return parts;
};

describe("Codex の LanguageModel（#265）", () => {
  test("新しいスレッドを作って回答を流し、スレッド ID を system/init の形で知らせる", async () => {
    const server = fakeAppServer((message, send) => {
      if (message.method === "thread/start") {
        return { thread: { id: "thread-1" } };
      }
      if (message.method === "turn/start") {
        setTimeout(() => {
          send({
            method: "turn/started",
            params: { threadId: "thread-1", turn: { id: "turn-1" } },
          });
          send({
            method: "item/agentMessage/delta",
            params: { threadId: "thread-1", itemId: "m1", delta: "こん" },
          });
          send({
            method: "item/agentMessage/delta",
            params: { threadId: "thread-1", itemId: "m1", delta: "にちは" },
          });
          send({
            method: "item/completed",
            params: {
              threadId: "thread-1",
              item: { type: "agentMessage", id: "m1", text: "こんにちは" },
            },
          });
          send({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-1",
              tokenUsage: {
                last: {
                  inputTokens: 10,
                  cachedInputTokens: 4,
                  outputTokens: 3,
                  reasoningOutputTokens: 1,
                },
              },
            },
          });
          send({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "completed", error: null },
            },
          });
        }, 0);
        return { turn: { id: "turn-1" } };
      }
      return undefined;
    });
    const parts = await collect(
      createCodex({ spawn: server.spawn })("gpt-test"),
      {
        cwd: "/work",
        context: "参照資料",
      },
    );
    expect(parts.find((p) => p.type === "raw")?.rawValue).toEqual({
      type: "system",
      subtype: "init",
      session_id: "thread-1",
    });
    expect(
      parts.filter((p) => p.type === "text-delta").map((p) => p.text),
    ).toEqual(["こん", "にちは"]);
    expect(parts.find((p) => p.type === "finish")).toMatchObject({
      totalUsage: { inputTokens: 10, outputTokens: 3 },
    });
    const start = server.requests.find((r) => r.method === "thread/start");
    expect(start?.params).toMatchObject({ model: "gpt-test", cwd: "/work" });
    const turn = server.requests.find((r) => r.method === "turn/start");
    expect(turn?.params.input[0].text).toBe("参照資料\n\nこんにちは");
  });

  test("セッション ID があれば thread/resume で続ける", async () => {
    const server = fakeAppServer((message, send) => {
      if (message.method === "thread/resume") {
        return { thread: { id: message.params.threadId } };
      }
      if (message.method === "turn/start") {
        setTimeout(
          () =>
            send({
              method: "turn/completed",
              params: {
                threadId: "saved",
                turn: { id: "t", status: "completed", error: null },
              },
            }),
          0,
        );
        return { turn: { id: "t" } };
      }
      return undefined;
    });
    const parts = await collect(
      createCodex({ spawn: server.spawn })("default"),
      {
        sessionId: "saved",
      },
    );
    expect(server.requests.map((r) => r.method)).toContain("thread/resume");
    expect(server.requests.map((r) => r.method)).not.toContain("thread/start");
    // 続けるときは init を出さない（セッション ID は変わらない）
    expect(parts.some((p) => p.type === "raw")).toBe(false);
  });

  test("コマンド実行の承認を Monet の承認に回し、Bash のツールとして出す", async () => {
    const asked: { toolName: string; input: unknown }[] = [];
    const canUseTool: CanUseTool = async (toolName, input) => {
      asked.push({ toolName, input });
      return { behavior: "allow", updatedInput: input };
    };
    const server = fakeAppServer((message, send) => {
      if (message.method === "thread/start") return { thread: { id: "th" } };
      if (message.method === "turn/start") {
        setTimeout(() => {
          send({
            method: "item/started",
            params: {
              threadId: "th",
              item: {
                type: "commandExecution",
                id: "c1",
                command: "ls",
                cwd: "/work",
              },
            },
          });
          send({
            id: 900,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "th",
              turnId: "t",
              itemId: "c1",
              command: "ls",
            },
          });
          setTimeout(() => {
            send({
              method: "item/completed",
              params: {
                threadId: "th",
                item: {
                  type: "commandExecution",
                  id: "c1",
                  command: "ls",
                  status: "completed",
                  aggregatedOutput: "a.txt",
                  exitCode: 0,
                },
              },
            });
            send({
              method: "turn/completed",
              params: {
                threadId: "th",
                turn: { id: "t", status: "completed", error: null },
              },
            });
          }, 20);
        }, 0);
        return { turn: { id: "t" } };
      }
      return undefined;
    });
    const parts = await collect(
      createCodex({ spawn: server.spawn, canUseTool })("default"),
    );
    expect(asked).toEqual([
      { toolName: "Bash", input: { command: "ls", cwd: undefined } },
    ]);
    expect(server.responses).toEqual([
      { id: 900, result: { decision: "accept" } },
    ]);
    expect(parts.find((p) => p.type === "tool-call")).toMatchObject({
      toolName: "Bash",
      toolCallId: "c1",
    });
    expect(parts.find((p) => p.type === "tool-result")).toMatchObject({
      toolCallId: "c1",
      output: "a.txt",
    });
  });

  test("失敗したターンはエラーとして流す", async () => {
    const server = fakeAppServer((message, send) => {
      if (message.method === "thread/start") return { thread: { id: "th" } };
      if (message.method === "turn/start") {
        setTimeout(
          () =>
            send({
              method: "turn/completed",
              params: {
                threadId: "th",
                turn: {
                  id: "t",
                  status: "failed",
                  error: { message: "利用上限に達しました" },
                },
              },
            }),
          0,
        );
        return { turn: { id: "t" } };
      }
      return undefined;
    });
    const parts = await collect(
      createCodex({ spawn: server.spawn })("default"),
    );
    const error = parts.find((p) => p.type === "error");
    expect(String(error?.error)).toContain("利用上限に達しました");
  });
});

describe("Codex の状態（#265）", () => {
  test("見つからなければ、理由とインストールの手順を返す", async () => {
    const status = await probeCodex({ which: () => null, clientVersion: "0" });
    expect(status).toMatchObject({ state: "unavailable" });
    if (status.state !== "unavailable") throw new Error("unreachable");
    expect(status.reason).toContain("見つかりません");
    expect(status.setup.join("\n")).toContain("codex login");
  });

  test("ログインしていなければ、ログインの手順を返す", async () => {
    const server = fakeAppServer((message) =>
      message.method === "account/read" ? { account: null } : undefined,
    );
    const status = await probeCodex({
      which: () => "/bin/codex",
      spawn: server.spawn,
      clientVersion: "0",
    });
    expect(status).toMatchObject({
      state: "unavailable",
      reason: "Codex にログインしていません。",
    });
  });

  test("ログインしていれば、モデル一覧（既定のモデルを先頭、隠しモデルを除く）を返す", async () => {
    const server = fakeAppServer((message) => {
      if (message.method === "account/read")
        return { account: { type: "chatgpt" } };
      if (message.method === "model/list") {
        return {
          data: [
            {
              model: "a",
              displayName: "A",
              description: "",
              hidden: false,
              isDefault: false,
              supportedReasoningEfforts: [
                { reasoningEffort: "minimal" },
                { reasoningEffort: "high" },
              ],
            },
            {
              model: "b",
              displayName: "B",
              description: "",
              hidden: false,
              isDefault: true,
              supportedReasoningEfforts: [],
            },
            {
              model: "c",
              displayName: "C",
              description: "",
              hidden: true,
              isDefault: false,
              supportedReasoningEfforts: [],
            },
          ],
        };
      }
      return undefined;
    });
    const status = await probeCodex({
      which: () => "/bin/codex",
      spawn: server.spawn,
      clientVersion: "0",
    });
    expect(status.state).toBe("ready");
    if (status.state !== "ready") throw new Error("unreachable");
    expect(
      status.models.map((m) => [m.value, m.supportedEffortLevels]),
    ).toEqual([
      ["b", []],
      ["a", ["high"]],
    ]);
  });

  test("toModelInfos は effort の無いモデルを supportsEffort: false にする", () => {
    expect(
      toModelInfos([
        {
          model: "x",
          displayName: "X",
          description: "",
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [],
        },
      ])[0]?.supportsEffort,
    ).toBe(false);
  });
});
