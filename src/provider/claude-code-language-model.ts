import {
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart,
  type LanguageModelV4StreamResult,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { collectWarnings } from "./call-options.ts";
import { buildQueryOptions, extractLatestUserText } from "./convert-prompt.ts";
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

  async doGenerate(
    _options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    // #22 で doStream を集約して実装する。
    throw new UnsupportedFunctionalityError({ functionality: "doGenerate" });
  }

  async doStream(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    const prompt = extractLatestUserText(options.prompt);
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
    const messages = this.query({
      prompt: prompt.value.text,
      options: queryOptions,
    });
    const mapper = new StreamMapper();
    const includeRaw = options.includeRawChunks === true;

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: async (controller) => {
        controller.enqueue({ type: "stream-start", warnings });
        try {
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
            controller.enqueue({ type: "error", error });
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
