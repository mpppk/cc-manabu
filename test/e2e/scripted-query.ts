import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFunction } from "../../src/provider/types.ts";

/**
 * E2E 用のモック query()。プロンプトの内容で振る舞いを変える（台本）。
 *
 * - 「承認」を含む: Bash の承認を求め、許可なら「許可されました」、拒否なら「拒否されました」と返す
 * - 「ゆっくり」を含む: 1〜40 を 1 行ずつ、150ms 間隔で流す（リロード・停止の確認用）
 * - それ以外: 「了解: <プロンプト>」と返す
 *
 * resume / fork を受け取ったセッション ID はそのまま（fork なら新しい ID を）返す。
 */
export const createScriptedQuery = (): QueryFunction => {
  let counter = 0;
  return ({ prompt, options }) => {
    const text = typeof prompt === "string" ? prompt : "";
    const sessionId =
      options?.resume !== undefined && options.forkSession !== true
        ? options.resume
        : `session-${++counter}`;
    const signal = options?.abortController?.signal;
    const base = { session_id: sessionId, parent_tool_use_id: null };
    let block = 0;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });

    async function* textMessage(
      chunks: string[],
      delayMs: number,
    ): AsyncGenerator<SDKMessage> {
      const index = block++;
      yield {
        ...base,
        type: "stream_event",
        uuid: crypto.randomUUID(),
        event: { type: "message_start", message: {} },
      } as unknown as SDKMessage;
      yield {
        ...base,
        type: "stream_event",
        uuid: crypto.randomUUID(),
        event: {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
      } as unknown as SDKMessage;
      for (const chunk of chunks) {
        if (signal?.aborted) return;
        yield {
          ...base,
          type: "stream_event",
          uuid: crypto.randomUUID(),
          event: {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: chunk },
          },
        } as unknown as SDKMessage;
        if (delayMs > 0) await sleep(delayMs);
      }
      yield {
        ...base,
        type: "assistant",
        uuid: crypto.randomUUID(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: chunks.join("") }],
        },
      } as unknown as SDKMessage;
      yield {
        ...base,
        type: "stream_event",
        uuid: crypto.randomUUID(),
        event: { type: "content_block_stop", index },
      } as unknown as SDKMessage;
    }

    return (async function* (): AsyncGenerator<SDKMessage> {
      yield {
        ...base,
        type: "system",
        subtype: "init",
        model: "mock",
        uuid: crypto.randomUUID(),
      } as unknown as SDKMessage;

      if (text.includes("承認")) {
        const decision = await options?.canUseTool?.(
          "Bash",
          { command: "touch e2e.txt", description: "Create e2e.txt" },
          {
            signal: signal ?? new AbortController().signal,
            suggestions: [],
            toolUseID: "toolu_e2e",
            displayName: "Bash",
            description: "Create e2e.txt",
          } as never,
        );
        yield* textMessage(
          [
            decision?.behavior === "allow"
              ? "許可されました"
              : "拒否されました",
          ],
          0,
        );
      } else if (text.includes("ゆっくり")) {
        yield* textMessage(
          Array.from({ length: 40 }, (_, i) => `${i + 1}\n`),
          150,
        );
      } else {
        yield* textMessage(["了解: ", text], 0);
      }

      if (signal?.aborted) return;
      yield {
        ...base,
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        is_error: false,
        result: "",
        duration_ms: 10,
        duration_api_ms: 10,
        num_turns: 1,
        total_cost_usd: 0.001,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        permission_denials: [],
        uuid: crypto.randomUUID(),
      } as unknown as SDKMessage;
    })();
  };
};
