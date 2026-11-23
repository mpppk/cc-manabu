import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { readCallOptions, toEffort } from "./call-options.ts";
import type { ClaudeCodeModelId, ClaudeCodeProviderSettings } from "./types.ts";

export class NoUserMessageError extends ErrorFactory({
  name: "NoUserMessageError",
  message: "The prompt must end with a user message.",
}) {}

/**
 * プロンプトの末尾のユーザー発話をテキストにする。
 * 履歴は Claude Code のセッションが持つため、過去のメッセージと system は送らない。
 */
export const extractLatestUserText = (
  prompt: LanguageModelV4Prompt,
): Result.Result<
  { text: string; warnings: SharedV4Warning[] },
  NoUserMessageError
> => {
  const last = prompt.at(-1);
  if (last === undefined || last.role !== "user") {
    return Result.fail(new NoUserMessageError());
  }
  const warnings: SharedV4Warning[] = [];
  const texts: string[] = [];
  for (const part of last.content) {
    if (part.type === "text") {
      texts.push(part.text);
    } else {
      warnings.push({
        type: "unsupported",
        feature: `user content part: ${part.type}`,
        details: "Only text is sent to Claude Code.",
      });
    }
  }
  if (prompt.some((message) => message.role === "system")) {
    warnings.push({
      type: "unsupported",
      feature: "system messages",
      details:
        "System messages in the prompt are ignored. Use appendSystemPrompt in the provider settings.",
    });
  }
  return Result.succeed({ text: texts.join("\n\n"), warnings });
};

const DEFAULT_SETTING_SOURCES = ["user", "project", "local"] as const;

/** AI SDK の呼び出しと Provider の設定から、Agent SDK の `query()` のオプションを組み立てる。 */
export const buildQueryOptions = (params: {
  modelId: ClaudeCodeModelId;
  settings: ClaudeCodeProviderSettings;
  callOptions: LanguageModelV4CallOptions;
  abortController: AbortController;
}): Options => {
  const { modelId, settings, callOptions, abortController } = params;
  const { sessionId, resumeSessionAt, forkSession } =
    readCallOptions(callOptions);
  const { effort, thinkingDisabled } = toEffort(callOptions.reasoning);

  return {
    abortController,
    includePartialMessages: true,
    ...(modelId === "default" ? {} : { model: modelId }),
    cwd: settings.cwd ?? process.cwd(),
    settingSources: [...(settings.settingSources ?? DEFAULT_SETTING_SOURCES)],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(settings.appendSystemPrompt === undefined
        ? {}
        : { append: settings.appendSystemPrompt }),
    },
    // 本文付きの thinking を受け取る（docs/spikes/models-and-auth.md）
    thinking: thinkingDisabled
      ? { type: "disabled" }
      : { type: "adaptive", display: "summarized" },
    ...(effort === undefined ? {} : { effort }),
    ...(settings.pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: settings.pathToClaudeCodeExecutable }),
    ...(settings.canUseTool === undefined
      ? {}
      : { canUseTool: settings.canUseTool }),
    ...(settings.permissionMode === undefined
      ? {}
      : { permissionMode: settings.permissionMode }),
    ...(settings.env === undefined ? {} : { env: settings.env }),
    ...(sessionId === undefined
      ? {}
      : {
          resume: sessionId,
          ...(resumeSessionAt === undefined ? {} : { resumeSessionAt }),
          ...(forkSession ? { forkSession: true } : {}),
        }),
  };
};
