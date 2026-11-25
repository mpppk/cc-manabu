import type {
  AccountInfo,
  ModelInfo,
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { QueryFunction } from "../provider/types.ts";

/**
 * Agent SDK の `query()` を、子プロセスの `claude` と stream-json で直接話して実装する。
 *
 * デスクトップアプリ版（artifact）では Node が無く Agent SDK を動かせないので、SDK が
 * 内部でしているのと同じことをする（docs/spikes/desktop-artifact.md）:
 *
 * 1. `claude --output-format stream-json --input-format stream-json ...` を起動する
 * 2. `initialize` の control_request を送る（システムプロンプトはここで渡す）
 * 3. 発言を stdin に書き、stdout の SDKMessage を順に返す
 * 4. `can_use_tool` の control_request が来たら `canUseTool` に聞いて答える
 * 5. 発言を書き終えていて `result` が来たら stdin を閉じる（プロセスが終わる）
 */

/** 子プロセス。artifact の `desktop.childProcess.spawn` の戻り値と同じ形。 */
export type ClaudeChildProcess = {
  stdout: { on(event: "data", listener: (chunk: string) => void): void };
  stderr: { on(event: "data", listener: (chunk: string) => void): void };
  stdin: { write(data: string): Promise<unknown>; end(): Promise<unknown> };
  on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<unknown>;
};

/** `claude` を引数つきで起動する。どの実行ファイルをどう起動するかは呼ぶ側が決める。 */
export type SpawnClaude = (
  args: string[],
  options: { cwd: string | undefined },
) => ClaudeChildProcess;

/** query() が返すもの。Agent SDK の Query のうち、cc-manabu が使う部分。 */
export type ProcessQuery = AsyncIterable<SDKMessage> &
  AsyncIterator<SDKMessage, void> & {
    supportedModels(): Promise<ModelInfo[]>;
    accountInfo(): Promise<AccountInfo>;
    interrupt(): Promise<void>;
    return(value?: unknown): Promise<IteratorResult<SDKMessage, void>>;
  };

type InitializeRequest = {
  subtype: "initialize";
  systemPrompt?: string[];
  appendSystemPrompt?: string;
};

/**
 * Agent SDK の Options を `claude` の引数と initialize の中身にする。
 * SDK（0.3.330）の ProcessTransport と同じ規則に従う。
 */
export const buildClaudeInvocation = (
  options: Options = {},
): { args: string[]; initialize: InitializeRequest } => {
  const args = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
  ];
  const thinking = options.thinking;
  if (thinking !== undefined) {
    if (thinking.type === "disabled") {
      args.push("--thinking=disabled");
    } else if (thinking.type === "enabled" && thinking.budgetTokens) {
      args.push("--max-thinking-tokens", String(thinking.budgetTokens));
    } else {
      args.push("--thinking=adaptive");
    }
    if (thinking.type !== "disabled" && thinking.display !== undefined) {
      args.push("--thinking-display", thinking.display);
    }
  }
  if (options.effort !== undefined) args.push("--effort", options.effort);
  if (options.maxTurns) args.push("--max-turns", String(options.maxTurns));
  if (options.model !== undefined) args.push("--model", options.model);
  if (options.canUseTool !== undefined) {
    args.push("--permission-prompt-tool=stdio");
  }
  if (options.resume !== undefined) args.push("--resume", options.resume);
  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }
  if (
    options.disallowedTools !== undefined &&
    options.disallowedTools.length > 0
  ) {
    args.push("--disallowedTools", options.disallowedTools.join(","));
  }
  if (Array.isArray(options.tools)) {
    args.push("--tools", options.tools.join(","));
  } else if (options.tools !== undefined) {
    args.push("--tools=default");
  }
  if (options.settingSources !== undefined) {
    args.push("--setting-sources", options.settingSources.join(","));
  }
  if (options.permissionMode !== undefined) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.includePartialMessages) args.push("--include-partial-messages");
  for (const dir of options.additionalDirectories ?? []) {
    args.push("--add-dir", dir);
  }
  if (options.forkSession) args.push("--fork-session");
  if (options.resumeSessionAt !== undefined) {
    args.push("--resume-session-at", options.resumeSessionAt);
  }
  if (options.persistSession === false) args.push("--no-session-persistence");

  // システムプロンプト: 未指定は空、文字列はそのまま、preset は append だけを渡す（SDK と同じ）
  const initialize: InitializeRequest = { subtype: "initialize" };
  const systemPrompt = options.systemPrompt;
  if (systemPrompt === undefined) {
    initialize.systemPrompt = [""];
  } else if (typeof systemPrompt === "string") {
    initialize.systemPrompt = [systemPrompt];
  } else if (Array.isArray(systemPrompt)) {
    initialize.systemPrompt = systemPrompt;
  } else if (systemPrompt.type === "preset") {
    if (systemPrompt.append !== undefined) {
      initialize.appendSystemPrompt = systemPrompt.append;
    }
  } else {
    initialize.systemPrompt = Array.isArray(systemPrompt.prompt)
      ? systemPrompt.prompt
      : [systemPrompt.prompt];
  }
  return { args, initialize };
};

/** stdout の断片を行に分ける。 */
export const createLineSplitter = (onLine: (line: string) => void) => {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    for (
      let index = buffer.indexOf("\n");
      index >= 0;
      index = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") onLine(line);
    }
  };
};

type ControlResponse =
  | { subtype: "success"; request_id: string; response?: unknown }
  | { subtype: "error"; request_id: string; error?: string };

type ControlRequest = {
  type: "control_request";
  request_id: string;
  request: {
    subtype: string;
    tool_name?: string;
    input?: Record<string, unknown>;
    permission_suggestions?: unknown;
    blocked_path?: string;
    decision_reason?: string;
    tool_use_id?: string;
    agent_id?: string;
    title?: string;
    display_name?: string;
    description?: string;
  };
};

type PermissionSuggestions = Parameters<
  NonNullable<Options["canUseTool"]>
>[2]["suggestions"];

type InitializeResponse = {
  models?: ModelInfo[];
  account?: AccountInfo;
};

const STDERR_TAIL = 4000;

/** 子プロセスの `claude` で動く query()。 */
export const createProcessQuery = (spawn: SpawnClaude): QueryFunction => {
  return ({ prompt, options }) => startProcessQuery(spawn, prompt, options);
};

export const startProcessQuery = (
  spawn: SpawnClaude,
  prompt: string | AsyncIterable<SDKUserMessage>,
  options: Options = {},
): ProcessQuery => {
  const { args, initialize } = buildClaudeInvocation(options);
  const queue: SDKMessage[] = [];
  let waiting: (() => void) | undefined;
  let finished = false;
  let failure: Error | undefined;
  let stderr = "";
  let gotResult = false;
  let inputDone = false;
  let stdinClosed = false;
  let seq = 0;
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const cancels = new Map<string, AbortController>();

  const wake = () => {
    const resolve = waiting;
    waiting = undefined;
    resolve?.();
  };
  const finish = (error?: Error) => {
    if (finished) return;
    finished = true;
    failure ??= error;
    for (const [, entry] of pending) {
      entry.reject(error ?? new Error("Claude Code のプロセスが終了しました"));
    }
    pending.clear();
    for (const [, controller] of cancels) controller.abort();
    cancels.clear();
    wake();
  };

  const child = spawn(args, { cwd: options.cwd });

  const write = (message: unknown): Promise<unknown> =>
    child.stdin.write(`${JSON.stringify(message)}\n`);

  const closeStdin = () => {
    if (stdinClosed) return;
    stdinClosed = true;
    child.stdin.end().catch(() => {});
  };

  const request = (body: Record<string, unknown>): Promise<unknown> => {
    seq += 1;
    const requestId = `req_${Date.now().toString(36)}_${seq}`;
    return new Promise((resolve, reject) => {
      if (finished) {
        reject(failure ?? new Error("Claude Code のプロセスが終了しました"));
        return;
      }
      pending.set(requestId, { resolve, reject });
      write({
        request_id: requestId,
        type: "control_request",
        request: body,
      }).catch((error: unknown) => {
        pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  const respond = (requestId: string, response: Record<string, unknown>) =>
    write({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  const respondError = (requestId: string, error: string) =>
    write({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error },
    });

  const handleControlRequest = async (message: ControlRequest) => {
    const { request_id: requestId, request: body } = message;
    if (body.subtype !== "can_use_tool" || options.canUseTool === undefined) {
      await respondError(
        requestId,
        `cc-manabu does not handle control request: ${body.subtype}`,
      ).catch(() => {});
      return;
    }
    const controller = new AbortController();
    cancels.set(requestId, controller);
    try {
      const result: PermissionResult | null = await options.canUseTool(
        body.tool_name ?? "",
        body.input ?? {},
        {
          signal: controller.signal,
          suggestions: body.permission_suggestions as PermissionSuggestions,
          blockedPath: body.blocked_path,
          decisionReason: body.decision_reason,
          toolUseID: body.tool_use_id ?? "",
          agentID: body.agent_id,
          title: body.title,
          displayName: body.display_name,
          description: body.description,
          requestId,
        },
      );
      // null は「答えない」（SDK と同じ。別の手段で答える場合）
      if (result === null || finished || controller.signal.aborted) return;
      await respond(requestId, { ...result, toolUseID: body.tool_use_id });
    } catch (error) {
      if (finished || controller.signal.aborted) return;
      await respondError(
        requestId,
        error instanceof Error ? error.message : String(error),
      ).catch(() => {});
    } finally {
      cancels.delete(requestId);
    }
  };

  const onLine = (line: string) => {
    let message: { type?: string } & Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    switch (message.type) {
      case "control_response": {
        const response = message.response as ControlResponse;
        const entry = pending.get(response.request_id);
        if (entry === undefined) return;
        pending.delete(response.request_id);
        if (response.subtype === "success") entry.resolve(response.response);
        else
          entry.reject(new Error(response.error ?? "control request failed"));
        return;
      }
      case "control_request":
        void handleControlRequest(message as unknown as ControlRequest);
        return;
      case "control_cancel_request": {
        const requestId = message.request_id as string;
        cancels.get(requestId)?.abort();
        cancels.delete(requestId);
        return;
      }
      case "keep_alive":
        return;
      default:
        if (message.type === "result") {
          gotResult = true;
          if (inputDone) closeStdin();
        }
        queue.push(message as unknown as SDKMessage);
        wake();
    }
  };

  child.stdout.on("data", createLineSplitter(onLine));
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  child.on("error", (error) => finish(error));
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null && !gotResult && !aborted()) {
      const detail = stderr.trim();
      finish(
        new Error(
          `Claude Code exited with code ${code}${detail === "" ? "" : `: ${detail}`}`,
        ),
      );
      return;
    }
    if (code === null && signal !== null && !gotResult && !aborted()) {
      finish(new Error(`Claude Code was terminated by ${signal}`));
      return;
    }
    finish();
  });

  const aborted = () => options.abortController?.signal.aborted === true;
  const kill = () => {
    child.kill().catch(() => {});
  };
  if (aborted()) {
    kill();
  } else {
    options.abortController?.signal.addEventListener("abort", kill, {
      once: true,
    });
  }

  const initialized = request(
    initialize as unknown as Record<string, unknown>,
  ) as Promise<InitializeResponse>;
  // 未処理の reject にしない（使うのは models・account と、発言を書く前の待ち合わせ）
  initialized.catch(() => {});

  const writeInput = async () => {
    try {
      await initialized;
      if (typeof prompt === "string") {
        await write({
          type: "user",
          session_id: "",
          message: { role: "user", content: [{ type: "text", text: prompt }] },
          parent_tool_use_id: null,
        });
      } else {
        for await (const message of prompt) {
          if (finished) return;
          await write(message);
        }
      }
      inputDone = true;
      if (gotResult) closeStdin();
    } catch (error) {
      if (!finished && !aborted()) {
        finish(error instanceof Error ? error : new Error(String(error)));
        kill();
      }
    }
  };
  void writeInput();

  const next = async (): Promise<IteratorResult<SDKMessage, void>> => {
    for (;;) {
      const message = queue.shift();
      if (message !== undefined) return { done: false, value: message };
      if (finished) {
        if (failure !== undefined) {
          const error = failure;
          failure = undefined;
          throw error;
        }
        return { done: true, value: undefined };
      }
      await new Promise<void>((resolve) => {
        waiting = resolve;
      });
    }
  };

  const query: ProcessQuery = {
    [Symbol.asyncIterator]() {
      return query;
    },
    next,
    async return() {
      if (!finished) {
        kill();
        finish();
      }
      queue.length = 0;
      return { done: true, value: undefined };
    },
    async supportedModels() {
      return (await initialized).models ?? [];
    },
    async accountInfo() {
      return (await initialized).account ?? {};
    },
    async interrupt() {
      await request({ subtype: "interrupt" });
    },
  };
  return query;
};
