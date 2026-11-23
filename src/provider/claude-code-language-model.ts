import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { collectWarnings, readCallOptions } from "./call-options.ts";
import { collectStream } from "./collect-stream.ts";
import {
  buildQueryOptions,
  extractLatestUserPrompt,
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

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: async (controller) => {
        controller.enqueue({ type: "stream-start", warnings });
        try {
          const messages = this.query({
            prompt: toQueryPrompt({
              ...prompt.value,
              context: readCallOptions(options).context,
            }),
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
            for (const part of mapper.map(message)) {
              controller.enqueue(part);
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
