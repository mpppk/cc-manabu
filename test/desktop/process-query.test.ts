import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  buildClaudeInvocation,
  type ClaudeChildProcess,
  createLineSplitter,
  startProcessQuery,
} from "../../src/desktop/process-query.ts";

/** stdin に書かれた JSON を記録し、stdout・exit をテストから流せる子プロセス。 */
const fakeClaude = () => {
  const written: Record<string, unknown>[] = [];
  const listeners: {
    stdout: ((chunk: string) => void)[];
    stderr: ((chunk: string) => void)[];
    exit: ((code: number | null, signal: string | null) => void)[];
    error: ((error: Error) => void)[];
  } = { stdout: [], stderr: [], exit: [], error: [] };
  let spawned: { args: string[]; cwd: string | undefined } | undefined;
  let stdinEnded = false;
  let killed = false;
  const onWrite: ((message: Record<string, unknown>) => void)[] = [];
  const child: ClaudeChildProcess = {
    stdout: { on: (_event, listener) => listeners.stdout.push(listener) },
    stderr: { on: (_event, listener) => listeners.stderr.push(listener) },
    stdin: {
      write: async (data) => {
        for (const line of data.split("\n").filter(Boolean)) {
          const message = JSON.parse(line);
          written.push(message);
          for (const fn of onWrite) fn(message);
        }
      },
      end: async () => {
        stdinEnded = true;
      },
    },
    on: ((event: "exit" | "error", listener: never) => {
      listeners[event].push(listener);
    }) as ClaudeChildProcess["on"],
    kill: async () => {
      killed = true;
    },
  };
  return {
    spawn: (args: string[], options: { cwd: string | undefined }) => {
      spawned = { args, cwd: options.cwd };
      return child;
    },
    written,
    /** stdin に書かれたら呼ぶ（初期化への応答などに使う）。 */
    onWrite: (fn: (message: Record<string, unknown>) => void) =>
      onWrite.push(fn),
    emit: (message: unknown) => {
      for (const fn of listeners.stdout) fn(`${JSON.stringify(message)}\n`);
    },
    stderr: (text: string) => {
      for (const fn of listeners.stderr) fn(text);
    },
    exit: (code: number | null, signal: string | null = null) => {
      for (const fn of listeners.exit) fn(code, signal);
    },
    get spawned() {
      return spawned;
    },
    get stdinEnded() {
      return stdinEnded;
    },
    get killed() {
      return killed;
    },
  };
};

/** initialize に成功で答える。 */
const answerInitialize = (
  claude: ReturnType<typeof fakeClaude>,
  response: Record<string, unknown> = {},
) =>
  claude.onWrite((message) => {
    const request = message.request as { subtype?: string } | undefined;
    if (
      message.type === "control_request" &&
      request?.subtype === "initialize"
    ) {
      queueMicrotask(() =>
        claude.emit({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response,
          },
        }),
      );
    }
  });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const collect = async (iterable: AsyncIterable<SDKMessage>) => {
  const messages: SDKMessage[] = [];
  for await (const message of iterable) messages.push(message);
  return messages;
};

describe("buildClaudeInvocation", () => {
  test("SDK の Options を claude の引数と initialize に変換する", () => {
    const { args, initialize } = buildClaudeInvocation({
      model: "haiku",
      effort: "high",
      thinking: { type: "adaptive", display: "summarized" },
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      additionalDirectories: ["/docs", "/notes"],
      resume: "session-1",
      resumeSessionAt: "uuid-1",
      forkSession: true,
      canUseTool: async () => ({ behavior: "deny", message: "no" }),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "日本語で",
      },
    });
    expect(args.slice(0, 5)).toEqual([
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
    ]);
    expect(args).toContain("--thinking=adaptive");
    expect(args.join(" ")).toContain("--thinking-display summarized");
    expect(args.join(" ")).toContain("--effort high");
    expect(args.join(" ")).toContain("--model haiku");
    expect(args).toContain("--permission-prompt-tool=stdio");
    expect(args.join(" ")).toContain("--resume session-1");
    expect(args.join(" ")).toContain("--resume-session-at uuid-1");
    expect(args).toContain("--fork-session");
    expect(args.join(" ")).toContain("--add-dir /docs --add-dir /notes");
    expect(args.join(" ")).toContain("--setting-sources user,project,local");
    expect(args).toContain("--include-partial-messages");
    expect(initialize).toEqual({
      subtype: "initialize",
      appendSystemPrompt: "日本語で",
    });
  });

  test("軽い呼び出し: 独自のシステムプロンプト、ツールなし、セッションを保存しない", () => {
    const { args, initialize } = buildClaudeInvocation({
      systemPrompt: "用語を抜き出す",
      tools: [],
      settingSources: [],
      persistSession: false,
      thinking: { type: "disabled" },
    });
    expect(args.join(" ")).toContain("--tools ");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--thinking=disabled");
    expect(args).not.toContain("--permission-prompt-tool=stdio");
    expect(initialize.systemPrompt).toEqual(["用語を抜き出す"]);
  });

  test("システムプロンプト未指定は空（SDK と同じ）", () => {
    expect(buildClaudeInvocation({}).initialize.systemPrompt).toEqual([""]);
  });
});

describe("createLineSplitter", () => {
  test("途中で切れた行をつなぎ、空行を捨てる", () => {
    const lines: string[] = [];
    const push = createLineSplitter((line) => lines.push(line));
    push('{"a":');
    push('1}\n\n{"b"');
    push(":2}\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("startProcessQuery", () => {
  test("initialize の後に発言を書き、メッセージを返し、result で stdin を閉じる", async () => {
    const claude = fakeClaude();
    answerInitialize(claude, {
      models: [{ value: "haiku", displayName: "Haiku" }],
      account: { subscriptionType: "Max" },
    });
    claude.onWrite((message) => {
      if (message.type !== "user") return;
      queueMicrotask(() => {
        claude.emit({ type: "system", subtype: "init", session_id: "s1" });
        claude.emit({ type: "keep_alive" });
        claude.emit({ type: "result", subtype: "success", session_id: "s1" });
      });
    });
    const query = startProcessQuery(claude.spawn, "こんにちは", {
      cwd: "/work",
      model: "haiku",
    });
    const pending = collect(query);
    await flush();
    await flush();
    expect(claude.spawned?.cwd).toBe("/work");
    expect(claude.written[0]).toMatchObject({
      type: "control_request",
      request: { subtype: "initialize" },
    });
    expect(claude.written[1]).toEqual({
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: [{ type: "text", text: "こんにちは" }],
      },
      parent_tool_use_id: null,
    });
    expect(claude.stdinEnded).toBe(true);
    claude.exit(0);
    const messages = await pending;
    expect(messages.map((m) => m.type)).toEqual(["system", "result"]);
    expect(await query.supportedModels()).toEqual([
      { value: "haiku", displayName: "Haiku" } as never,
    ]);
    expect(await query.accountInfo()).toEqual({ subscriptionType: "Max" });
  });

  test("can_use_tool を canUseTool に渡し、答えを toolUseID 付きで返す", async () => {
    const claude = fakeClaude();
    answerInitialize(claude);
    const calls: { tool: string; input: unknown; toolUseID: string }[] = [];
    startProcessQuery(claude.spawn, "touch a.txt", {
      canUseTool: async (tool, input, { toolUseID }) => {
        calls.push({ tool, input, toolUseID });
        return { behavior: "allow", updatedInput: input };
      },
    });
    await flush();
    claude.emit({
      type: "control_request",
      request_id: "perm-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "touch a.txt" },
        tool_use_id: "toolu_1",
      },
    });
    await flush();
    expect(calls).toEqual([
      { tool: "Bash", input: { command: "touch a.txt" }, toolUseID: "toolu_1" },
    ]);
    expect(claude.written.at(-1)).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "perm-1",
        response: {
          behavior: "allow",
          updatedInput: { command: "touch a.txt" },
          toolUseID: "toolu_1",
        },
      },
    });
  });

  test("control_cancel_request で承認待ちを取り消し、答えない", async () => {
    const claude = fakeClaude();
    answerInitialize(claude);
    let signal: AbortSignal | undefined;
    startProcessQuery(claude.spawn, "x", {
      canUseTool: (_tool, _input, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    });
    await flush();
    claude.emit({
      type: "control_request",
      request_id: "perm-2",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
    });
    await flush();
    claude.emit({ type: "control_cancel_request", request_id: "perm-2" });
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(
      claude.written.filter((m) => m.type === "control_response"),
    ).toHaveLength(0);
  });

  test("知らない control_request にはエラーで答える", async () => {
    const claude = fakeClaude();
    answerInitialize(claude);
    startProcessQuery(claude.spawn, "x");
    await flush();
    claude.emit({
      type: "control_request",
      request_id: "hook-1",
      request: { subtype: "hook_callback" },
    });
    await flush();
    expect(claude.written.at(-1)).toMatchObject({
      type: "control_response",
      response: { subtype: "error", request_id: "hook-1" },
    });
  });

  test("result の前に異常終了したら、stderr を添えて例外にする", async () => {
    const claude = fakeClaude();
    answerInitialize(claude);
    const query = startProcessQuery(claude.spawn, "x");
    await flush();
    claude.stderr("Invalid API key · Please run /login\n");
    claude.exit(1);
    await expect(collect(query)).rejects.toThrow(/code 1: Invalid API key/);
  });

  test("abortController で止めるとプロセスを終わらせる", async () => {
    const claude = fakeClaude();
    answerInitialize(claude);
    const abortController = new AbortController();
    const query = startProcessQuery(claude.spawn, "x", { abortController });
    await flush();
    abortController.abort();
    expect(claude.killed).toBe(true);
    claude.exit(null, "SIGTERM");
    expect(await collect(query)).toEqual([]);
  });

  test("発言のストリーム（画像・参照資料つき）を順に書き、終わってから result で stdin を閉じる", async () => {
    const claude = fakeClaude();
    answerInitialize(claude);
    claude.onWrite((message) => {
      if (message.type === "user") {
        queueMicrotask(() =>
          claude.emit({ type: "result", subtype: "success" }),
        );
      }
    });
    const input = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "user" as const,
          session_id: "",
          parent_tool_use_id: null,
          message: {
            role: "user" as const,
            content: [{ type: "text" as const, text: "画像" }],
          },
        };
      },
    };
    const query = startProcessQuery(claude.spawn, input);
    const pending = collect(query);
    await flush();
    await flush();
    expect(claude.written[1]).toMatchObject({ type: "user" });
    expect(claude.stdinEnded).toBe(true);
    claude.exit(0);
    expect((await pending).map((m) => m.type)).toEqual(["result"]);
  });
});
