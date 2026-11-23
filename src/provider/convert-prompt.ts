import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FilePart,
  LanguageModelV4Prompt,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { readCallOptions, toEffort } from "./call-options.ts";
import type { ClaudeCodeModelId, ClaudeCodeProviderSettings } from "./types.ts";

export class NoUserMessageError extends ErrorFactory({
  name: "NoUserMessageError",
  message: "The prompt must end with a user message.",
}) {}

/** Claude に渡す画像（base64）。 */
export type PromptImage = { mediaType: string; base64: string };

/** 末尾のユーザー発話から取り出した、Claude Code に送る内容。 */
export type UserPrompt = {
  text: string;
  images: PromptImage[];
  warnings: SharedV4Warning[];
};

/** Claude が受け付ける画像の形式。 */
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const toBase64 = (data: Uint8Array | string): string =>
  typeof data === "string" ? data : Buffer.from(data).toString("base64");

/** file パーツを画像にする。送れないものは理由を返す。 */
const toImage = (
  part: LanguageModelV4FilePart,
): PromptImage | { unsupported: string } => {
  if (!SUPPORTED_IMAGE_TYPES.has(part.mediaType)) {
    return { unsupported: `file part: ${part.mediaType}` };
  }
  const { data } = part;
  if (data.type === "data") {
    return { mediaType: part.mediaType, base64: toBase64(data.data) };
  }
  if (data.type === "url" && data.url.protocol === "data:") {
    const comma = data.url.href.indexOf(",");
    if (data.url.href.slice(0, comma).endsWith(";base64")) {
      return {
        mediaType: part.mediaType,
        base64: data.url.href.slice(comma + 1),
      };
    }
  }
  return { unsupported: `file part data: ${data.type}` };
};

/**
 * プロンプトの末尾のユーザー発話から、テキストと画像を取り出す。
 * 履歴は Claude Code のセッションが持つため、過去のメッセージと system は送らない。
 */
export const extractLatestUserPrompt = (
  prompt: LanguageModelV4Prompt,
): Result.Result<UserPrompt, NoUserMessageError> => {
  const last = prompt.at(-1);
  if (last === undefined || last.role !== "user") {
    return Result.fail(new NoUserMessageError());
  }
  const warnings: SharedV4Warning[] = [];
  const texts: string[] = [];
  const images: PromptImage[] = [];
  for (const part of last.content) {
    if (part.type === "text") {
      if (part.text !== "") {
        texts.push(part.text);
      }
      continue;
    }
    const image = part.type === "file" ? toImage(part) : undefined;
    if (image !== undefined && !("unsupported" in image)) {
      images.push(image);
      continue;
    }
    warnings.push({
      type: "unsupported",
      feature: image?.unsupported ?? `user content part: ${part.type}`,
      details:
        "Only text and PNG / JPEG / GIF / WebP images are sent to Claude Code.",
    });
  }
  if (prompt.some((message) => message.role === "system")) {
    warnings.push({
      type: "unsupported",
      feature: "system messages",
      details:
        "System messages in the prompt are ignored. Use appendSystemPrompt in the provider settings.",
    });
  }
  return Result.succeed({ text: texts.join("\n\n"), images, warnings });
};

/**
 * `query()` の prompt にする。画像が無ければ文字列、あれば画像ブロックを含む
 * ユーザーメッセージを 1 つ流す AsyncIterable（docs/spikes/image-input.md）。
 */
export const toQueryPrompt = (
  prompt: Pick<UserPrompt, "text" | "images">,
): string | AsyncIterable<SDKUserMessage> => {
  if (prompt.images.length === 0) {
    return prompt.text;
  }
  const message: SDKUserMessage = {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        ...prompt.images.map((image) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: image.mediaType as
              | "image/png"
              | "image/jpeg"
              | "image/gif"
              | "image/webp",
            data: image.base64,
          },
        })),
        ...(prompt.text === ""
          ? []
          : [{ type: "text" as const, text: prompt.text }]),
      ],
    },
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield message;
    },
  };
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
