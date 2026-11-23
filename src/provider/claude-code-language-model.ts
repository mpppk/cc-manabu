import {
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamResult,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
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
    _options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    // #20 で実装する。
    throw new UnsupportedFunctionalityError({ functionality: "doStream" });
  }
}
