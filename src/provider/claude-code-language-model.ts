import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import {
  type Query,
  type SDKControlGetContextUsageResponse,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { collectWarnings, readCallOptions } from "./call-options.ts";
import { collectStream } from "./collect-stream.ts";
import {
  buildQueryOptions,
  extractLatestUserPrompt,
  holdOpen,
  toQueryPrompt,
} from "./convert-prompt.ts";
import { classifyThrownError } from "./errors.ts";
import { StreamMapper } from "./map-stream.ts";
import {
  type ClaudeCodeModelId,
  type ClaudeCodeProviderSettings,
  PROVIDER_NAME,
  type QueryFunction,
} from "./types.ts";

/** コンテキストの使用量の問い合わせを待つ時間。答えが無ければ取らずに進む。 */
const CONTEXT_USAGE_TIMEOUT_MS = 5000;

/**
 * 回答のあとのコンテキストの使用量（#245）。query() が getContextUsage を持たない（テストの差し替えなど）・
 * 失敗した・時間内に答えなかったときは undefined。
 */
const readContextUsage = async (
  messages: Query | AsyncIterable<unknown>,
): Promise<SDKControlGetContextUsageResponse | undefined> => {
  if (!("getContextUsage" in messages)) return undefined;
  if (typeof messages.getContextUsage !== "function") return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      messages.getContextUsage({ detail: "summary" }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), CONTEXT_USAGE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Claude Agent SDK の `query()` を包む AI SDK の LanguageModel（spec v4）。
 * 1 回の呼び出しが Claude Code の 1 ターンに対応する。
 */
export class ClaudeCodeLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = PROVIDER_NAME;
  readonly modelId: ClaudeCodeModelId;
  /** URL の画像などは扱わない。 */
  readonly supportedUrls: Record<string, RegExp[]> = {};

  readonly settings: ClaudeCodeProviderSettings;
  protected readonly query: QueryFunction;

  constructor(
    modelId: ClaudeCodeModelId,
    settings: ClaudeCodeProviderSettings,
  ) {
    this.modelId = modelId;
    this.settings = settings;
    this.query = settings.query ?? sdkQuery;
  }

  /** doStream の結果をまとめて返す。途中でエラーが起きたら例外にする（AI SDK との境界）。 */
  async doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    const { stream, request } = await this.doStream(options);
    const collected = await collectStream(stream);
    if (collected.hasError) {
      throw collected.error;
    }
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
    if (Result.isFailure(prompt)) {
      // AI SDK との境界なので例外にする
      throw prompt.error;
    }
    const warnings = [...collectWarnings(options), ...prompt.value.warnings];

    const abortController = new AbortController();
    const abort = () => abortController.abort(options.abortSignal?.reason);
    if (options.abortSignal?.aborted) {
      abort();
    } else {
      options.abortSignal?.addEventListener("abort", abort, { once: true });
    }

    const queryOptions = buildQueryOptions({
      modelId: this.modelId,
      settings: this.settings,
      callOptions: options,
      abortController,
    });
    const mapper = new StreamMapper();
    const includeRaw = options.includeRawChunks === true;
    // コンテキストの使用量を取るなら、回答のあとに聞き終えるまで入力を開けておく（#245）
    const onContextUsage = prompt.value.text.trimStart().startsWith("/")
      ? undefined
      : this.settings.onContextUsage;
    let releaseInput = () => {};
    const inputDone = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    abortController.signal.addEventListener("abort", () => releaseInput(), {
      once: true,
    });

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: async (controller) => {
        controller.enqueue({ type: "stream-start", warnings });
        try {
          const queryPrompt = toQueryPrompt({
            ...prompt.value,
            context: readCallOptions(options).context,
          });
          const messages = this.query({
            prompt:
              onContextUsage === undefined
                ? queryPrompt
                : holdOpen(queryPrompt, inputDone),
            options: queryOptions,
          });
          for await (const message of messages) {
            // abort 後も SDK はバッファ済みのメッセージを流してくるので捨てる（docs/spikes/sdk-messages.md）
            if (abortController.signal.aborted) {
              break;
            }
            if (includeRaw) {
              controller.enqueue({ type: "raw", rawValue: message });
            }
            if (message.type === "rate_limit_event") {
              this.settings.onRateLimit?.(message.rate_limit_info);
            }
            for (const part of mapper.map(message)) {
              controller.enqueue(part);
            }
            if (message.type === "result") {
              if (onContextUsage !== undefined) {
                const usage = await readContextUsage(messages);
                if (usage !== undefined) {
                  try {
                    onContextUsage(usage);
                  } catch {
                    // 使用量の記録は回答に影響させない
                  }
                }
              }
              releaseInput();
            }
          }
        } catch (error) {
          if (!abortController.signal.aborted) {
            controller.enqueue({
              type: "error",
              error: classifyThrownError(
                error,
                this.settings.pathToClaudeCodeExecutable,
              ),
            });
          }
        } finally {
          releaseInput();
          options.abortSignal?.removeEventListener("abort", abort);
          if (abortController.signal.aborted) {
            for (const part of mapper.closeOpenBlocks()) {
              controller.enqueue(part);
            }
          }
          controller.close();
        }
      },
      cancel: () => {
        abortController.abort();
      },
    });

    return {
      stream,
      request: {
        body: {
          prompt: prompt.value.text,
          images: prompt.value.images.map((image) => image.mediaType),
          context: readCallOptions(options).context,
          model: queryOptions.model,
          resume: queryOptions.resume,
          resumeSessionAt: queryOptions.resumeSessionAt,
          forkSession: queryOptions.forkSession,
          effort: queryOptions.effort,
        },
      },
    };
  }
}
