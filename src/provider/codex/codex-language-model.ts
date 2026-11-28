/**
 * Codex App Server を AI SDK の LanguageModel（spec v4）として包む（#265）。
 * 1 回の呼び出しが Codex のスレッドの 1 ターンに対応する。会話の続きは thread/resume で再開する。
 *
 * - 本文・推論の要約・コマンド実行・ファイル変更を、Claude Code と同じ形のストリームに変換する
 *   （コマンドは Bash、ファイル変更は Edit / Write のツールとして出す）
 * - コマンド実行・ファイル変更の承認は、Monet の承認（canUseTool）に回す
 * - 新しいスレッドの ID は、Claude Code の system/init と同じ形の raw チャンクで知らせる
 *   （ChatService がセッション ID として保存し、次の送信で再開する）
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { readCallOptions } from "../call-options.ts";
import { collectStream } from "../collect-stream.ts";
import { extractLatestUserPrompt } from "../convert-prompt.ts";
import { PROVIDER_NAME } from "../types.ts";
import {
  type CodexAppServer,
  connectCodex,
  type SpawnAppServer,
  spawnCodexAppServer,
} from "./app-server.ts";

export const CODEX_PROVIDER_NAME = "codex";

export type CodexProviderSettings = {
  /** App Server の起動（テストでは差し替える）。既定は PATH 上の `codex app-server`。 */
  spawn?: SpawnAppServer;
  /** initialize で名乗るバージョン。 */
  clientVersion?: string;
  /** ツールの承認（Monet の承認 UI）。無ければ承認を求められた操作は断る。 */
  canUseTool?: CanUseTool;
  /** 開発者向けの指示（出典の付け方など）。 */
  appendSystemPrompt?: string;
};

type Item = { type: string; id: string } & Record<string, unknown>;

/** Codex の effort。AI SDK の reasoning から変換する。 */
const toCodexEffort = (
  reasoning: LanguageModelV4CallOptions["reasoning"],
): string | undefined => {
  switch (reasoning) {
    case undefined:
    case "provider-default":
      return undefined;
    case "max":
      return "xhigh";
    default:
      return reasoning;
  }
};

const emptyUsage = (): LanguageModelV4Usage => ({
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
});

/** コマンド実行・ファイル変更を、Monet のツールの表示（Bash / Edit / Write）に合わせる。 */
const toolOf = (
  item: Item,
): { name: string; input: Record<string, unknown> } | undefined => {
  switch (item.type) {
    case "commandExecution":
      return {
        name: "Bash",
        input: { command: String(item.command ?? ""), cwd: item.cwd },
      };
    case "fileChange": {
      const changes = Array.isArray(item.changes)
        ? (item.changes as { path?: unknown; kind?: { type?: unknown } }[])
        : [];
      const [first] = changes;
      return {
        name: first?.kind?.type === "add" ? "Write" : "Edit",
        input: {
          file_path: typeof first?.path === "string" ? first.path : "",
          changes,
        },
      };
    }
    case "mcpToolCall":
      return {
        name: `mcp__${String(item.server)}__${String(item.tool)}`,
        input: (item.arguments as Record<string, unknown>) ?? {},
      };
    case "webSearch":
      return { name: "WebSearch", input: { query: item.query ?? "" } };
    default:
      return undefined;
  }
};

/** ツールの結果。 */
const toolResultOf = (item: Item): { result: unknown; isError: boolean } => {
  switch (item.type) {
    case "commandExecution":
      return {
        result: String(item.aggregatedOutput ?? ""),
        isError:
          item.status === "failed" ||
          item.status === "declined" ||
          (typeof item.exitCode === "number" && item.exitCode !== 0),
      };
    case "fileChange":
      return {
        result: item.status === "completed" ? "変更しました。" : item.status,
        isError: item.status !== "completed",
      };
    case "mcpToolCall":
      return {
        result: item.result ?? item.error ?? "",
        isError: item.status === "failed",
      };
    default:
      return { result: "", isError: false };
  }
};

export class CodexLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = CODEX_PROVIDER_NAME;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  private readonly settings: CodexProviderSettings;

  constructor(modelId: string, settings: CodexProviderSettings = {}) {
    this.modelId = modelId;
    this.settings = settings;
  }

  async doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    const { stream, request } = await this.doStream(options);
    const collected = await collectStream(stream);
    if (collected.hasError) throw collected.error;
    return {
      content: collected.content,
      finishReason: collected.finishReason,
      usage: collected.usage,
      providerMetadata: collected.providerMetadata,
      request,
      response: collected.response,
      warnings: collected.warnings,
    };
  }

  async doStream(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    const prompt = extractLatestUserPrompt(options.prompt);
    if (Result.isFailure(prompt)) throw prompt.error;
    const call = readCallOptions(options);
    const warnings: SharedV4Warning[] = [...prompt.value.warnings];
    if (prompt.value.images.length > 0) {
      warnings.push({
        type: "unsupported",
        feature: "images",
        details: "Monet does not send images to Codex yet.",
      });
    }
    const text = [call.context, prompt.value.text]
      .filter((part): part is string => part !== undefined && part !== "")
      .join("\n\n");
    const effort = toCodexEffort(options.reasoning);
    const model = this.modelId === "default" ? undefined : this.modelId;
    const settings = this.settings;
    const includeRaw = options.includeRawChunks === true;
    const signal = options.abortSignal;

    let server: CodexAppServer | undefined;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: async (controller) => {
        controller.enqueue({ type: "stream-start", warnings });
        const enqueue = (part: LanguageModelV4StreamPart) => {
          try {
            controller.enqueue(part);
          } catch {
            // 閉じたあと（停止後など）は捨てる
          }
        };
        const connected = await connectCodex(
          settings.spawn ?? spawnCodexAppServer(),
          settings.clientVersion ?? "0",
        );
        if (Result.isFailure(connected)) {
          enqueue({ type: "error", error: connected.error });
          controller.close();
          return;
        }
        server = connected.value;
        const app = server;
        const done = Promise.withResolvers<void>();
        let threadId: string | undefined;
        let turnId: string | undefined;
        let usage = emptyUsage();
        /** 開いている本文・推論のブロック（item id → 種類）。 */
        const open = new Map<string, "text" | "reasoning">();
        const started = new Set<string>();
        let failed = false;

        const close = (id: string) => {
          const kind = open.get(id);
          if (kind === undefined) return;
          open.delete(id);
          enqueue({ type: kind === "text" ? "text-end" : "reasoning-end", id });
        };
        const delta = (
          id: string,
          kind: "text" | "reasoning",
          value: string,
        ) => {
          if (!open.has(id)) {
            open.set(id, kind);
            enqueue({
              type: kind === "text" ? "text-start" : "reasoning-start",
              id,
            });
          }
          enqueue({
            type: kind === "text" ? "text-delta" : "reasoning-delta",
            id,
            delta: value,
          });
        };
        const startTool = (item: Item) => {
          const tool = toolOf(item);
          if (tool === undefined || started.has(item.id)) return;
          started.add(item.id);
          enqueue({
            type: "tool-call",
            toolCallId: item.id,
            toolName: tool.name,
            input: JSON.stringify(tool.input),
            providerExecuted: true,
            dynamic: true,
          });
        };

        app.onNotification((method, raw) => {
          const params = (raw ?? {}) as Record<string, unknown>;
          if (
            threadId !== undefined &&
            params.threadId !== undefined &&
            params.threadId !== threadId
          ) {
            return;
          }
          switch (method) {
            case "turn/started":
              turnId = (params.turn as { id?: string } | undefined)?.id;
              return;
            case "item/agentMessage/delta":
              delta(String(params.itemId), "text", String(params.delta ?? ""));
              return;
            case "item/reasoning/summaryTextDelta":
            case "item/reasoning/textDelta":
              delta(
                `${String(params.itemId)}:reasoning`,
                "reasoning",
                String(params.delta ?? ""),
              );
              return;
            case "item/started":
              startTool(params.item as Item);
              return;
            case "item/completed": {
              const item = params.item as Item;
              if (item.type === "agentMessage") {
                // 差分が届かなかった本文は、まとめて出す
                if (!open.has(item.id) && typeof item.text === "string") {
                  if (item.text !== "") delta(item.id, "text", item.text);
                }
                close(item.id);
                return;
              }
              if (item.type === "reasoning") {
                close(`${item.id}:reasoning`);
                return;
              }
              const tool = toolOf(item);
              if (tool === undefined) return;
              startTool(item);
              const { result, isError } = toolResultOf(item);
              enqueue({
                type: "tool-result",
                toolCallId: item.id,
                toolName: tool.name,
                result: result as never,
                ...(isError ? { isError: true } : {}),
                dynamic: true,
              });
              return;
            }
            case "thread/tokenUsage/updated": {
              const last = (
                params.tokenUsage as
                  | {
                      last?: {
                        inputTokens?: number;
                        cachedInputTokens?: number;
                        outputTokens?: number;
                        reasoningOutputTokens?: number;
                      };
                    }
                  | undefined
              )?.last;
              if (last === undefined) return;
              usage = {
                inputTokens: {
                  total: last.inputTokens,
                  noCache:
                    last.inputTokens === undefined
                      ? undefined
                      : last.inputTokens - (last.cachedInputTokens ?? 0),
                  cacheRead: last.cachedInputTokens,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: last.outputTokens,
                  text:
                    last.outputTokens === undefined
                      ? undefined
                      : last.outputTokens - (last.reasoningOutputTokens ?? 0),
                  reasoning: last.reasoningOutputTokens,
                },
              };
              return;
            }
            case "error": {
              if (params.willRetry === true) return;
              const error = params.error as { message?: string } | undefined;
              failed = true;
              enqueue({
                type: "error",
                error: new Error(
                  error?.message ?? "Codex でエラーが起きました。",
                ),
              });
              return;
            }
            case "turn/completed": {
              const turn = params.turn as
                | { status?: string; error?: { message?: string } | null }
                | undefined;
              for (const id of [...open.keys()]) close(id);
              if (turn?.status === "failed" && !failed) {
                failed = true;
                enqueue({
                  type: "error",
                  error: new Error(
                    turn.error?.message ?? "Codex の回答が失敗しました。",
                  ),
                });
              }
              if (!failed) {
                enqueue({
                  type: "finish",
                  finishReason: {
                    unified: turn?.status === "completed" ? "stop" : "other",
                    raw: turn?.status,
                  },
                  usage,
                  providerMetadata: {
                    [CODEX_PROVIDER_NAME]: { threadId: threadId ?? null },
                  },
                });
              }
              done.resolve();
              return;
            }
          }
        });

        // コマンド実行・ファイル変更の承認は、Monet の承認に回す
        const approve = async (
          toolName: string,
          input: Record<string, unknown>,
          toolUseID: string,
          description: string | undefined,
        ): Promise<"accept" | "decline"> => {
          if (settings.canUseTool === undefined) return "decline";
          const result = await settings.canUseTool(toolName, input, {
            signal: signal ?? new AbortController().signal,
            toolUseID,
            ...(description === undefined ? {} : { description }),
          } as Parameters<CanUseTool>[2]);
          return result?.behavior === "allow" ? "accept" : "decline";
        };
        app.onServerRequest(async (method, raw) => {
          const params = (raw ?? {}) as Record<string, unknown>;
          switch (method) {
            case "item/commandExecution/requestApproval":
              return {
                decision: await approve(
                  "Bash",
                  { command: String(params.command ?? ""), cwd: params.cwd },
                  String(params.itemId),
                  typeof params.reason === "string" ? params.reason : undefined,
                ),
              };
            case "item/fileChange/requestApproval":
              return {
                decision: await approve(
                  "Edit",
                  { file_path: "", reason: params.reason },
                  String(params.itemId),
                  typeof params.reason === "string" ? params.reason : undefined,
                ),
              };
            case "applyPatchApproval":
            case "execCommandApproval":
              return { decision: "denied" };
            default:
              throw new Error(`${method} には対応していません。`);
          }
        });

        const onAbort = () => {
          if (threadId !== undefined && turnId !== undefined) {
            void app.request("turn/interrupt", { threadId, turnId });
          }
          // 少し待ってから止める（中断を伝えるため）
          setTimeout(() => app.close(), 500);
          done.resolve();
        };
        if (signal?.aborted) {
          onAbort();
        } else {
          signal?.addEventListener("abort", onAbort, { once: true });
        }

        try {
          const threadParams = {
            ...(model === undefined ? {} : { model }),
            ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            ...(settings.appendSystemPrompt === undefined
              ? {}
              : { developerInstructions: settings.appendSystemPrompt }),
            ...(call.additionalDirectories === undefined
              ? {}
              : {
                  config: {
                    sandbox_workspace_write: {
                      writable_roots: call.additionalDirectories,
                    },
                  },
                }),
          };
          const thread = await (call.sessionId === undefined
            ? app.request<{ thread: { id: string } }>(
                "thread/start",
                threadParams,
              )
            : app.request<{ thread: { id: string } }>("thread/resume", {
                threadId: call.sessionId,
                ...threadParams,
              }));
          if (Result.isFailure(thread)) {
            if (!signal?.aborted) {
              enqueue({ type: "error", error: thread.error });
            }
            return;
          }
          threadId = thread.value.thread.id;
          if (includeRaw && call.sessionId === undefined) {
            // ChatService は system/init のセッション ID を会話に保存する
            enqueue({
              type: "raw",
              rawValue: {
                type: "system",
                subtype: "init",
                session_id: threadId,
              },
            });
          }
          enqueue({
            type: "response-metadata",
            id: threadId,
            modelId: model ?? "default",
            timestamp: new Date(),
          });
          const turn = await app.request<{ turn: { id: string } }>(
            "turn/start",
            {
              threadId,
              input: [{ type: "text", text, text_elements: [] }],
              ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
              ...(model === undefined ? {} : { model }),
              ...(effort === undefined ? {} : { effort }),
            },
          );
          if (Result.isFailure(turn)) {
            if (!signal?.aborted) {
              enqueue({ type: "error", error: turn.error });
            }
            return;
          }
          turnId ??= turn.value.turn.id;
          await done.promise;
        } finally {
          signal?.removeEventListener("abort", onAbort);
          for (const id of [...open.keys()]) close(id);
          if (!signal?.aborted) app.close();
          try {
            controller.close();
          } catch {
            // すでに閉じている
          }
        }
      },
      cancel: () => {
        server?.close();
      },
    });

    return {
      stream,
      request: {
        body: {
          prompt: prompt.value.text,
          context: call.context,
          model: this.modelId,
          threadId: call.sessionId,
          effort,
        },
      },
    };
  }
}

/** providerOptions を Claude Code と共有する（cwd・sessionId・context など）。 */
export const CODEX_CALL_OPTIONS_KEY = PROVIDER_NAME;

export const createCodex =
  (settings: CodexProviderSettings = {}) =>
  (modelId: string) =>
    new CodexLanguageModel(modelId, settings);
