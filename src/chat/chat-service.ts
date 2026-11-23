import type { LanguageModelV4 } from "@ai-sdk/provider";
import { Result } from "@praha/byethrow";
import {
  createUIMessageStream,
  generateId,
  streamText,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type {
  ChatNotFoundError,
  ChatRepository,
  DatabaseError,
} from "../db/chat-repository.ts";
import {
  type ClaudeCodeProviderMetadata,
  PROVIDER_NAME,
} from "../provider/index.ts";
import type { ChatRunner } from "./chat-runner.ts";
import { toUserErrorMessage } from "./error-messages.ts";
import type {
  ChatAlreadyRunningError,
  RunnerRegistry,
  TooManyRunnersError,
} from "./runner-registry.ts";

/** UIMessage の metadata に入れる値。 */
export type ChatMessageMetadata = {
  model?: string;
  claudeCode?: ClaudeCodeProviderMetadata;
  usage?: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    reasoningTokens: number | undefined;
    cachedInputTokens: number | undefined;
    totalTokens: number | undefined;
  };
  aborted?: boolean;
};

export type ChatUIMessage = UIMessage<ChatMessageMetadata>;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type SendInput = {
  chatId: string;
  /** 送信するユーザー発話（UIMessage）。 */
  message: { id: string; role: "user"; parts: ChatUIMessage["parts"] };
  model?: string;
  effort?: Effort | null;
};

export type SendError =
  | ChatNotFoundError
  | DatabaseError
  | ChatAlreadyRunningError
  | TooManyRunnersError;

const textOf = (parts: ChatUIMessage["parts"]): string =>
  parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text !== "")
    .join("\n\n");

const isInitMessage = (
  value: unknown,
): value is { type: "system"; subtype: "init"; session_id: string } =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === "system" &&
  (value as { subtype?: unknown }).subtype === "init" &&
  typeof (value as { session_id?: unknown }).session_id === "string";

/**
 * 送信・再接続・停止をまとめる。生成は ChatRunner で HTTP 接続と切り離して進め、
 * 終わったら（成功・中断・エラーとも）応答を DB に保存する。
 */
export const createChatService = (deps: {
  chats: ChatRepository;
  registry: RunnerRegistry;
  languageModel: (modelId: string) => LanguageModelV4;
}) => {
  const { chats, registry } = deps;

  const startGeneration = (params: {
    chatId: string;
    model: string;
    effort: Effort | null;
    sessionId: string | null;
    prompt: string;
    resumeSessionAt?: string;
    forkSession?: boolean;
  }): Result.Result<
    ChatRunner,
    ChatAlreadyRunningError | TooManyRunnersError
  > =>
    registry.start(params.chatId, (signal) =>
      createUIMessageStream<ChatUIMessage>({
        generateId,
        execute: ({ writer }) => {
          const result = streamText({
            model: deps.languageModel(params.model),
            messages: [{ role: "user", content: params.prompt }],
            ...(params.effort === null ? {} : { reasoning: params.effort }),
            providerOptions: {
              [PROVIDER_NAME]: {
                ...(params.sessionId === null
                  ? {}
                  : { sessionId: params.sessionId }),
                ...(params.resumeSessionAt === undefined
                  ? {}
                  : { resumeSessionAt: params.resumeSessionAt }),
                ...(params.forkSession === true ? { forkSession: true } : {}),
              },
            },
            abortSignal: signal,
            includeRawChunks: true,
            onChunk: ({ chunk }) => {
              // 新しいセッション（fork を含む）の ID は、最初の system/init で分かる
              if (chunk.type === "raw" && isInitMessage(chunk.rawValue)) {
                chats.updateChat(params.chatId, {
                  sessionId: chunk.rawValue.session_id,
                });
              }
            },
          });
          writer.merge(
            result.toUIMessageStream<ChatUIMessage>({
              sendReasoning: true,
              onError: toUserErrorMessage,
              messageMetadata: ({ part }) => {
                if (part.type === "start") {
                  return { model: params.model };
                }
                if (part.type === "finish-step") {
                  return {
                    claudeCode: part.providerMetadata?.[PROVIDER_NAME] as
                      | ClaudeCodeProviderMetadata
                      | undefined,
                  };
                }
                if (part.type === "finish") {
                  return {
                    usage: {
                      inputTokens: part.totalUsage.inputTokens,
                      outputTokens: part.totalUsage.outputTokens,
                      reasoningTokens:
                        part.totalUsage.outputTokenDetails?.reasoningTokens,
                      cachedInputTokens:
                        part.totalUsage.inputTokenDetails?.cacheReadTokens,
                      totalTokens: part.totalUsage.totalTokens,
                    },
                  };
                }
                return undefined;
              },
            }),
          );
        },
        onFinish: ({ responseMessage, isAborted }) => {
          const metadata = {
            ...responseMessage.metadata,
            ...(isAborted ? { aborted: true } : {}),
          };
          if (responseMessage.parts.length > 0) {
            chats.saveMessage(params.chatId, {
              id: responseMessage.id,
              role: "assistant",
              parts: responseMessage.parts,
              metadata,
              sdkUuid: metadata.claudeCode?.lastAssistantUuid ?? null,
            });
          }
        },
      }),
    );

  const send = (input: SendInput): Result.Result<ChatRunner, SendError> =>
    Result.pipe(
      chats.getChat(input.chatId),
      Result.andThen(({ chat }) =>
        chats.updateChat(chat.id, {
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
        }),
      ),
      Result.andThen((chat) =>
        Result.pipe(
          chats.saveMessage(chat.id, {
            id: input.message.id,
            role: "user",
            parts: input.message.parts,
          }),
          Result.map(() => chat),
        ),
      ),
      Result.andThen((chat) =>
        startGeneration({
          chatId: chat.id,
          model: chat.model,
          effort: (chat.effort as Effort | null) ?? null,
          sessionId: chat.sessionId,
          prompt: textOf(input.message.parts),
        }),
      ),
      Result.inspect((runner) => trackStatus(runner)),
    );

  const trackStatus = (runner: ChatRunner) => {
    chats.setStatus(runner.chatId, "running");
    runner.done.then(() => {
      const failed = runner
        .snapshot()
        .some((chunk: UIMessageChunk) => chunk.type === "error");
      chats.setStatus(runner.chatId, failed ? "error" : "idle");
    });
  };

  return {
    send,
    startGeneration,
    trackStatus,
    /** 生成中なら Runner を返す。無ければ undefined。 */
    reconnect: (chatId: string): ChatRunner | undefined => registry.get(chatId),
    stop: (chatId: string): boolean => registry.stop(chatId),
  };
};

export type ChatService = ReturnType<typeof createChatService>;
