import { ClaudeCodeLanguageModel } from "./claude-code-language-model.ts";
import type { ClaudeCodeModelId, ClaudeCodeProviderSettings } from "./types.ts";

export { ClaudeCodeLanguageModel } from "./claude-code-language-model.ts";
export {
  ClaudeCodeApiError,
  type ClaudeCodeError,
  ClaudeCodeExecutionError,
  ClaudeCodeNotFoundError,
  ClaudeCodeProcessError,
  isAuthenticationError,
  isRetryableError,
} from "./errors.ts";
export type { ClaudeCodeProviderMetadata } from "./map-stream.ts";
export type {
  ClaudeCodeCallOptions,
  ClaudeCodeModelId,
  ClaudeCodeProviderSettings,
  QueryFunction,
} from "./types.ts";
export { PROVIDER_NAME } from "./types.ts";

export type ClaudeCodeProvider = {
  (modelId: ClaudeCodeModelId): ClaudeCodeLanguageModel;
  languageModel(modelId: ClaudeCodeModelId): ClaudeCodeLanguageModel;
};

/**
 * 自前の Claude Code provider を作る。
 *
 * @example
 * const claudeCode = createClaudeCode({ pathToClaudeCodeExecutable: "/usr/local/bin/claude" });
 * streamText({ model: claudeCode("sonnet"), prompt: "hi" });
 */
export const createClaudeCode = (
  settings: ClaudeCodeProviderSettings = {},
): ClaudeCodeProvider => {
  const languageModel = (modelId: ClaudeCodeModelId) =>
    new ClaudeCodeLanguageModel(modelId, settings);
  return Object.assign(languageModel, { languageModel });
};
