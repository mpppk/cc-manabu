import type {
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4ResponseMetadata,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { mapUsage } from "./map-stream.ts";

export type CollectedStream = {
  content: LanguageModelV4Content[];
  finishReason: LanguageModelV4FinishReason;
  usage: LanguageModelV4Usage;
  providerMetadata: SharedV4ProviderMetadata | undefined;
  response: LanguageModelV4ResponseMetadata;
  warnings: SharedV4Warning[];
  /** 途中で error パーツが来たら、最初のものを入れる。 */
  error: unknown;
  hasError: boolean;
};

/**
 * doStream のパーツを doGenerate の結果にまとめる。
 * テキストと reasoning は id ごとに連結し、出現順を保つ。
 */
export const collectStream = async (
  stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<CollectedStream> => {
  const content: LanguageModelV4Content[] = [];
  const open = new Map<string, LanguageModelV4Content>();
  const collected: CollectedStream = {
    content,
    finishReason: { unified: "other", raw: undefined },
    usage: mapUsage(undefined),
    providerMetadata: undefined,
    response: {},
    warnings: [],
    error: undefined,
    hasError: false,
  };

  for await (const part of stream) {
    switch (part.type) {
      case "stream-start":
        collected.warnings = part.warnings;
        break;
      case "response-metadata":
        collected.response = {
          ...(part.id === undefined ? {} : { id: part.id }),
          ...(part.modelId === undefined ? {} : { modelId: part.modelId }),
          ...(part.timestamp === undefined
            ? {}
            : { timestamp: part.timestamp }),
        };
        break;
      case "text-start": {
        const text: LanguageModelV4Content = { type: "text", text: "" };
        open.set(`text:${part.id}`, text);
        content.push(text);
        break;
      }
      case "text-delta": {
        const text = open.get(`text:${part.id}`);
        if (text?.type === "text") {
          text.text += part.delta;
        }
        break;
      }
      case "reasoning-start": {
        const reasoning: LanguageModelV4Content = {
          type: "reasoning",
          text: "",
        };
        open.set(`reasoning:${part.id}`, reasoning);
        content.push(reasoning);
        break;
      }
      case "reasoning-delta": {
        const reasoning = open.get(`reasoning:${part.id}`);
        if (reasoning?.type === "reasoning") {
          reasoning.text += part.delta;
        }
        break;
      }
      case "tool-call":
      case "tool-result":
        content.push(part);
        break;
      case "finish":
        collected.finishReason = part.finishReason;
        collected.usage = part.usage;
        collected.providerMetadata = part.providerMetadata;
        break;
      case "error":
        if (!collected.hasError) {
          collected.error = part.error;
          collected.hasError = true;
        }
        break;
      default:
        break;
    }
  }
  return collected;
};
