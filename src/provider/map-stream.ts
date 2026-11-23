import type {
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import type {
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeApiError, ClaudeCodeExecutionError } from "./errors.ts";
import { PROVIDER_NAME } from "./types.ts";

type BlockKind = "text" | "reasoning" | "tool-input";

/** finish の providerMetadata["claude-code"] に入れる値。 */
export type ClaudeCodeProviderMetadata = {
  sessionId: string | undefined;
  /** このターンで最後に届いた assistant メッセージの uuid。再生成・編集の分岐点に使う。 */
  lastAssistantUuid: string | undefined;
  costUsd: number | undefined;
  durationMs: number | undefined;
  numTurns: number | undefined;
  /** canUseTool や設定で拒否されたツール呼び出し。 */
  permissionDenials: { toolName: string; toolUseId: string }[];
};

export const mapFinishReason = (
  result: Pick<SDKResultMessage, "subtype" | "stop_reason">,
): LanguageModelV4FinishReason => {
  const raw = result.stop_reason ?? result.subtype;
  switch (result.subtype) {
    case "error_max_turns":
    case "error_max_budget_usd":
      return { unified: "length", raw };
    case "error_during_execution":
    case "error_max_structured_output_retries":
      return { unified: "error", raw };
    default:
      break;
  }
  switch (result.stop_reason) {
    case null:
    case undefined:
    case "end_turn":
    case "stop_sequence":
      return { unified: "stop", raw };
    case "max_tokens":
      return { unified: "length", raw };
    case "tool_use":
      return { unified: "tool-calls", raw };
    case "refusal":
      return { unified: "content-filter", raw };
    default:
      return { unified: "other", raw };
  }
};

export const mapUsage = (
  usage: SDKResultMessage["usage"] | undefined,
): LanguageModelV4Usage => {
  if (usage === undefined) {
    return {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
  }
  const noCache = usage.input_tokens;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const reasoning = (
    usage as { output_tokens_details?: { thinking_tokens?: number } }
  ).output_tokens_details?.thinking_tokens;
  return {
    inputTokens: {
      total: noCache + cacheRead + cacheWrite,
      noCache,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: usage.output_tokens,
      text:
        reasoning === undefined ? undefined : usage.output_tokens - reasoning,
      reasoning,
    },
  };
};

/** tool_result の content を AI SDK の result（JSON 値）にする。 */
const toToolResultValue = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string }) =>
        block.type === "text" && typeof block.text === "string"
          ? block.text
          : `[${block.type ?? "unknown"}]`,
      )
      .join("\n");
  }
  return JSON.stringify(content ?? null);
};

/**
 * SDKMessage を LanguageModelV4 の stream part に変換する。
 * Claude Code の 1 ターン（1 回の query）につき 1 つ作る。
 *
 * - テキストと thinking は stream_event（partial）から組み立てる
 * - ツール呼び出しは assistant メッセージの tool_use から、結果は user メッセージの tool_result から作る
 * - サブエージェント内のメッセージ（parent_tool_use_id あり）は MVP では流さない
 * - 未知のメッセージは無視する（docs/spikes/sdk-messages.md）
 */
export class StreamMapper {
  private messageIndex = 0;
  private readonly openBlocks = new Map<
    number,
    { kind: BlockKind; id: string }
  >();
  private readonly toolNames = new Map<string, string>();
  private sessionId: string | undefined;
  private lastAssistantUuid: string | undefined;

  map(message: SDKMessage): LanguageModelV4StreamPart[] {
    if (
      "parent_tool_use_id" in message &&
      message.parent_tool_use_id !== null &&
      message.parent_tool_use_id !== undefined
    ) {
      return [];
    }
    if ("session_id" in message && typeof message.session_id === "string") {
      this.sessionId = message.session_id;
    }

    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          return [
            {
              type: "response-metadata",
              modelId: message.model,
              timestamp: new Date(),
            },
          ];
        }
        return [];
      case "stream_event":
        return this.mapStreamEvent(message.event);
      case "assistant":
        return this.mapAssistant(message);
      case "user":
        return this.mapUser(message);
      case "result":
        return this.closeOpenBlocks().concat(this.mapResult(message));
      default:
        return [];
    }
  }

  /** 中断などで result が来ないまま終わるときに、開いているブロックを閉じる。 */
  closeOpenBlocks(): LanguageModelV4StreamPart[] {
    const parts: LanguageModelV4StreamPart[] = [];
    for (const block of this.openBlocks.values()) {
      parts.push(this.endPart(block));
    }
    this.openBlocks.clear();
    return parts;
  }

  metadata(
    result?: SDKResultMessage,
  ): ClaudeCodeProviderMetadata & SharedV4ProviderMetadata[string] {
    return {
      sessionId: this.sessionId,
      lastAssistantUuid: this.lastAssistantUuid,
      costUsd: result?.total_cost_usd,
      durationMs: result?.duration_ms,
      numTurns: result?.num_turns,
      permissionDenials: (result?.permission_denials ?? []).map((denial) => ({
        toolName: denial.tool_name,
        toolUseId: denial.tool_use_id,
      })),
    };
  }

  private mapStreamEvent(
    event: Extract<SDKMessage, { type: "stream_event" }>["event"],
  ): LanguageModelV4StreamPart[] {
    switch (event.type) {
      case "message_start":
        this.messageIndex += 1;
        return [];
      case "content_block_start": {
        const block = event.content_block;
        const id = `${this.messageIndex}-${event.index}`;
        switch (block.type) {
          case "text":
            this.openBlocks.set(event.index, { kind: "text", id });
            return [{ type: "text-start", id }];
          case "thinking":
            this.openBlocks.set(event.index, { kind: "reasoning", id });
            return [{ type: "reasoning-start", id }];
          case "tool_use":
            this.toolNames.set(block.id, block.name);
            this.openBlocks.set(event.index, {
              kind: "tool-input",
              id: block.id,
            });
            return [
              {
                type: "tool-input-start",
                id: block.id,
                toolName: block.name,
                providerExecuted: true,
                dynamic: true,
              },
            ];
          default:
            return [];
        }
      }
      case "content_block_delta": {
        const block = this.openBlocks.get(event.index);
        if (block === undefined) {
          return [];
        }
        const delta = event.delta;
        if (delta.type === "text_delta" && block.kind === "text") {
          return [{ type: "text-delta", id: block.id, delta: delta.text }];
        }
        if (delta.type === "thinking_delta" && block.kind === "reasoning") {
          return [
            { type: "reasoning-delta", id: block.id, delta: delta.thinking },
          ];
        }
        if (delta.type === "input_json_delta" && block.kind === "tool-input") {
          return [
            {
              type: "tool-input-delta",
              id: block.id,
              delta: delta.partial_json,
            },
          ];
        }
        return [];
      }
      case "content_block_stop": {
        const block = this.openBlocks.get(event.index);
        if (block === undefined) {
          return [];
        }
        this.openBlocks.delete(event.index);
        return [this.endPart(block)];
      }
      default:
        return [];
    }
  }

  private mapAssistant(
    message: Extract<SDKMessage, { type: "assistant" }>,
  ): LanguageModelV4StreamPart[] {
    this.lastAssistantUuid = message.uuid;
    const parts: LanguageModelV4StreamPart[] = [];
    if (message.error !== undefined) {
      // 認証・課金・レート制限などのエラー。本文は Claude Code が作った説明文なので detail に残す
      const detail = message.message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();
      parts.push({
        type: "error",
        error: new ClaudeCodeApiError({
          kind: message.error,
          detail: detail === "" ? undefined : detail,
        }),
      });
      return parts;
    }
    for (const block of message.message.content) {
      if (block.type === "tool_use") {
        this.toolNames.set(block.id, block.name);
        parts.push({
          type: "tool-call",
          toolCallId: block.id,
          toolName: block.name,
          input: JSON.stringify(block.input ?? {}),
          providerExecuted: true,
          dynamic: true,
        });
      }
    }
    return parts;
  }

  private mapUser(
    message: Extract<SDKMessage, { type: "user" }>,
  ): LanguageModelV4StreamPart[] {
    const content = message.message.content;
    if (!Array.isArray(content)) {
      return [];
    }
    const parts: LanguageModelV4StreamPart[] = [];
    for (const block of content) {
      if (block.type === "tool_result") {
        parts.push({
          type: "tool-result",
          toolCallId: block.tool_use_id,
          toolName: this.toolNames.get(block.tool_use_id) ?? "unknown",
          result: toToolResultValue(block.content),
          ...(block.is_error === true ? { isError: true } : {}),
          dynamic: true,
        });
      }
    }
    return parts;
  }

  private mapResult(result: SDKResultMessage): LanguageModelV4StreamPart[] {
    const parts: LanguageModelV4StreamPart[] = [];
    if (result.subtype !== "success") {
      parts.push({
        type: "error",
        error: new ClaudeCodeExecutionError({
          subtype: result.subtype,
          errors: result.errors,
        }),
      });
    }
    return [
      ...parts,
      {
        type: "finish",
        usage: mapUsage(result.usage),
        finishReason: mapFinishReason(result),
        providerMetadata: { [PROVIDER_NAME]: this.metadata(result) },
      },
    ];
  }

  private endPart(block: {
    kind: BlockKind;
    id: string;
  }): LanguageModelV4StreamPart {
    switch (block.kind) {
      case "text":
        return { type: "text-end", id: block.id };
      case "reasoning":
        return { type: "reasoning-end", id: block.id };
      case "tool-input":
        return { type: "tool-input-end", id: block.id };
    }
  }
}
