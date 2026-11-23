import type {
  LanguageModelV4CallOptions,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { type ClaudeCodeCallOptions, PROVIDER_NAME } from "./types.ts";

/** Claude Code では効かない AI SDK の設定。指定されたら warning を返す。 */
const UNSUPPORTED_SETTINGS = [
  "maxOutputTokens",
  "temperature",
  "stopSequences",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
] as const satisfies readonly (keyof LanguageModelV4CallOptions)[];

export const collectWarnings = (
  options: LanguageModelV4CallOptions,
): SharedV4Warning[] => {
  const warnings: SharedV4Warning[] = [];
  for (const setting of UNSUPPORTED_SETTINGS) {
    if (options[setting] !== undefined) {
      warnings.push({
        type: "unsupported",
        feature: setting,
        details: "Claude Code does not support this setting.",
      });
    }
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    warnings.push({
      type: "unsupported",
      feature: "tools",
      details:
        "AI SDK tools are not executed. Claude Code uses its own built-in tools.",
    });
  }
  if (options.toolChoice !== undefined && options.toolChoice.type !== "auto") {
    warnings.push({ type: "unsupported", feature: "toolChoice" });
  }
  if (
    options.responseFormat !== undefined &&
    options.responseFormat.type !== "text"
  ) {
    warnings.push({ type: "unsupported", feature: "responseFormat" });
  }
  return warnings;
};

/** AI SDK の `reasoning` を Claude Code の effort に変換する。`none` は thinking を無効にする。 */
export const toEffort = (
  reasoning: LanguageModelV4CallOptions["reasoning"],
): { effort?: EffortLevel; thinkingDisabled: boolean } => {
  switch (reasoning) {
    case undefined:
    case "provider-default":
      return { thinkingDisabled: false };
    case "none":
      return { thinkingDisabled: true };
    case "minimal":
      return { effort: "low", thinkingDisabled: false };
    default:
      return { effort: reasoning, thinkingDisabled: false };
  }
};

/** providerOptions["claude-code"] を型付きで取り出す。 */
export const readCallOptions = (
  options: LanguageModelV4CallOptions,
): ClaudeCodeCallOptions => {
  const raw = options.providerOptions?.[PROVIDER_NAME] ?? {};
  const pick = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === "string" ? value : undefined;
  };
  return {
    sessionId: pick("sessionId"),
    resumeSessionAt: pick("resumeSessionAt"),
    forkSession: raw.forkSession === true,
    context: pick("context"),
  };
};
