import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import {
  createUIMessageStream,
  generateId,
  streamText,
  type UIMessage,
  type UIMessageChunk,
  type UserContent,
} from "ai";
import type {
  ChatNotFoundError,
  ChatRepository,
  DatabaseError,
} from "../db/chat-repository.ts";
import type { ChatRow, MessageRow } from "../db/schema.ts";
import {
  type ClaudeCodeProviderMetadata,
  PROVIDER_NAME,
} from "../provider/index.ts";
import type { AnswerCompleted } from "../wiki/auto-terms.ts";
import {
  type WikiContext,
  type WikiContextBuilder,
  type WikiPageReader,
  WikiPageUnavailableError,
  wikiPageContext,
} from "../wiki/context.ts";
import type { ApprovalBroker, ApprovalData } from "./approval-broker.ts";
import type { ChatRunner } from "./chat-runner.ts";
import { toUserErrorMessage } from "./error-messages.ts";
import { type QuoteData, quotesOf, quoteText } from "./quote.ts";
import type {
  ChatAlreadyRunningError,
  RunnerRegistry,
  TooManyRunnersError,
} from "./runner-registry.ts";
import { makeTitle } from "./title.ts";

export class MessageNotFoundError extends ErrorFactory({
  name: "MessageNotFoundError",
  message: (fields) => `User message not found: ${fields.messageId}`,
  fields: ErrorFactory.fields<{ messageId: string }>(),
}) {}

export class NotBranchableError extends ErrorFactory({
  name: "NotBranchableError",
  message: (fields) =>
    `This message cannot be a branch point (a completed assistant message is required): ${fields.messageId}`,
  fields: ErrorFactory.fields<{ messageId: string }>(),
}) {}

export class NothingToRegenerateError extends ErrorFactory({
  name: "NothingToRegenerateError",
  message: "There is no user message to regenerate a response for.",
}) {}

/**
 * index 番目のメッセージより前で、分岐点（sdk_uuid）を持つ最後の assistant 行。
 * 無ければ会話の最初からやり直す（新しいセッション）。
 */
const findForkPoint = (
  messages: MessageRow[],
  index: number,
): string | undefined =>
  messages
    .slice(0, index)
    .findLast((m) => m.role === "assistant" && m.sdkUuid !== null)?.sdkUuid ??
  undefined;

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
  /** このターンで参照資料として渡した Wiki ページ（引用をリンクにするのに使う）。 */
  wiki?: Omit<WikiContext, "text">;
};

export type ChatDataParts = {
  /** ツール実行の承認要求（id は approvalId。状態が変わると同じ id で上書きする）。 */
  approval: ApprovalData;
  /** 質問の対象として選んだ回答の一部（ユーザー発話に付ける）。 */
  quote: QuoteData;
};

export type ChatUIMessage = UIMessage<ChatMessageMetadata, ChatDataParts>;

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
  | WikiPageUnavailableError
  | ChatAlreadyRunningError
  | TooManyRunnersError;

const textOf = (parts: ChatUIMessage["parts"]): string =>
  parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text !== "")
    .join("\n\n");

/**
 * 送信で resume するセッション。自分のセッションがあればそれを、分岐でまだ無ければ
 * 分岐元のセッションを分岐点まで巻き戻して fork する（#76）。
 */
const resumeOf = (
  chat: ChatRow,
): {
  sessionId: string | null;
  resumeSessionAt?: string;
  forkSession?: boolean;
} =>
  chat.sessionId === null &&
  chat.forkSessionId !== null &&
  chat.forkFromUuid !== null
    ? {
        sessionId: chat.forkSessionId,
        resumeSessionAt: chat.forkFromUuid,
        forkSession: true,
      }
    : { sessionId: chat.sessionId };

const filesOf = (parts: ChatUIMessage["parts"]) =>
  parts.filter((part) => part.type === "file");

/** 最初の発話から付けるタイトル。画像だけなら「画像」。 */
const titleOf = (parts: ChatUIMessage["parts"]): string => {
  const text = textOf(parts);
  return text === "" && filesOf(parts).length > 0 ? "画像" : makeTitle(text);
};

/** ユーザー発話の parts を、モデルに渡す content（テキストと画像）にする。 */
export const toUserContent = (parts: ChatUIMessage["parts"]): UserContent => {
  const text = textOf(parts);
  return [
    ...quotesOf(parts).map((quote) => ({
      type: "text" as const,
      text: quoteText(quote),
    })),
    ...filesOf(parts).map((part) => ({
      type: "file" as const,
      mediaType: part.mediaType,
      // data URL のまま渡すと、AI SDK がバイト列にして Provider に渡す
      data: part.url,
    })),
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
  ];
};

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
  approvals: ApprovalBroker;
  /** 会話ごとの canUseTool を差し込んだモデルを返す。 */
  languageModel: (
    modelId: string,
    options: { canUseTool: CanUseTool },
  ) => LanguageModelV4;
  /** プロジェクトの会話で、質問に関係する Wiki ページを参照資料にする。 */
  wikiContext?: WikiContextBuilder;
  readWikiPage?: WikiPageReader;
  /**
   * プロジェクトの会話で回答が最後まで終わったとき（中断・エラーを除く）に呼ぶ。
   * 用語ページの自動作成（#80）に使う。回答の保存のあとに呼び、結果は待たない。
   */
  onAnswerComplete?: (event: AnswerCompleted) => void;
  /** 分岐の生成が終わったとき（予約したメッセージの送信に使う。#102）。 */
  onRunnerFinish?: (
    chatId: string,
    outcome: "success" | "aborted" | "error",
  ) => void;
}) => {
  const { chats, registry, approvals } = deps;

  const readWikiPage: WikiPageReader = (projectId, pageId) =>
    deps.readWikiPage?.(projectId, pageId) ??
    Result.fail(new WikiPageUnavailableError());

  /** ページにひも付く会話は、ページを参照できない場合に生成を始めない。 */
  const contextFor = (chat: ChatRow, parts: ChatUIMessage["parts"]) => {
    const { projectId, wikiPageId } = chat;
    const question = textOf(parts);
    if (wikiPageId === null) {
      return Result.succeed(
        projectId === null
          ? undefined
          : deps.wikiContext?.(projectId, question),
      );
    }
    if (projectId === null) return Result.fail(new WikiPageUnavailableError());
    return Result.pipe(
      readWikiPage(projectId, wikiPageId),
      Result.map((page) => wikiPageContext(projectId, page, question)),
    );
  };

  const startGeneration = (params: {
    chatId: string;
    model: string;
    effort: Effort | null;
    sessionId: string | null;
    content: UserContent;
    /** 会話の所属プロジェクト（回答後の用語ページ作成に使う）。 */
    projectId: string | null;
    /** 質問の本文（回答後の用語ページ作成に使う）。 */
    question: string;
    /** 質問とは別に渡す Wiki の参照資料。DB の発話には保存しない。 */
    context?: WikiContext;
    resumeSessionAt?: string;
    forkSession?: boolean;
  }): Result.Result<
    ChatRunner,
    ChatAlreadyRunningError | TooManyRunnersError
  > =>
    registry.start(params.chatId, (signal) => {
      let failed = false;
      return createUIMessageStream<ChatUIMessage>({
        generateId,
        execute: ({ writer }) => {
          const canUseTool = approvals.createCanUseTool(
            params.chatId,
            (chunk) => writer.write(chunk),
          );
          const result = streamText({
            model: deps.languageModel(params.model, { canUseTool }),
            messages: [{ role: "user", content: params.content }],
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
                ...(params.context === undefined
                  ? {}
                  : { context: params.context.text }),
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
              onError: (error) => {
                failed = true;
                return toUserErrorMessage(error);
              },
              messageMetadata: ({ part }) => {
                if (part.type === "start") {
                  return {
                    model: params.model,
                    ...(params.context === undefined
                      ? {}
                      : {
                          wiki: {
                            projectId: params.context.projectId,
                            pages: params.context.pages,
                            ...(params.context.excerpted
                              ? { excerpted: true }
                              : {}),
                          },
                        }),
                  };
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
          const answer = responseMessage.parts
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n\n");
          if (
            !isAborted &&
            !failed &&
            params.projectId !== null &&
            answer.trim() !== ""
          ) {
            try {
              deps.onAnswerComplete?.({
                chatId: params.chatId,
                projectId: params.projectId,
                messageId: responseMessage.id,
                question: params.question,
                answer,
              });
            } catch {
              // 用語ページの作成は回答に影響させない
            }
          }
        },
      });
    });

  const sendToChat = (
    chat: ChatRow,
    input: Omit<SendInput, "chatId">,
    context: WikiContext | undefined,
  ): Result.Result<ChatRunner, SendError> => {
    const titled = chat.title === "";
    return Result.pipe(
      chats.updateChat(chat.id, {
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        // 最初の発話でタイトルを付ける（名前を変えていればそのまま）
        ...(titled ? { title: titleOf(input.message.parts) } : {}),
      }),
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
      Result.inspect((chat) => {
        // 最初の発話で付けたタイトルは、会話（分岐のまとまり）で共有する
        if (titled && chat.groupId !== chat.id) {
          chats.setGroupTitle(chat.groupId, chat.title);
        }
      }),
      Result.andThen((chat) =>
        startGeneration({
          chatId: chat.id,
          model: chat.model,
          effort: (chat.effort as Effort | null) ?? null,
          ...resumeOf(chat),
          content: toUserContent(input.message.parts),
          projectId: chat.projectId,
          question: textOf(input.message.parts),
          context,
        }),
      ),
      Result.inspect((runner) => trackStatus(runner)),
    );
  };

  const send = (input: SendInput): Result.Result<ChatRunner, SendError> =>
    Result.pipe(
      registry.canStart(input.chatId),
      Result.andThen(() => chats.getChat(input.chatId)),
      Result.andThen(({ chat }) =>
        Result.pipe(
          contextFor(chat, input.message.parts),
          Result.andThen((context) => sendToChat(chat, input, context)),
        ),
      ),
    );

  const sendToWikiPage = (
    input: Omit<SendInput, "chatId"> & {
      projectId: string;
      pageId: string;
      cwd: string;
    },
  ): Result.Result<ChatRunner, SendError> => {
    const id = crypto.randomUUID();
    return Result.pipe(
      registry.canStart(id),
      Result.andThen(() => readWikiPage(input.projectId, input.pageId)),
      Result.andThen((page) =>
        Result.pipe(
          chats.getOrCreateWikiChat({
            id,
            projectId: input.projectId,
            wikiPageId: page.id,
            title: page.title,
            cwd: input.cwd,
          }),
          Result.andThen((chat) =>
            Result.pipe(
              registry.canStart(chat.id),
              Result.andThen(() =>
                sendToChat(
                  chat,
                  input,
                  wikiPageContext(
                    input.projectId,
                    page,
                    textOf(input.message.parts),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  };

  /**
   * 分岐を作り、最初の発話から生成を始める（#76）。分岐元のセッションを分岐点まで巻き戻して
   * fork し、新しいセッションを分岐に保存する。分岐元の会話はそのまま残る。
   */
  const branch = (input: {
    parentId: string;
    /** 分岐点にする、分岐元の完了した assistant メッセージ。 */
    messageId: string;
    /** 新しい分岐の id（クライアントが決める）。 */
    branchId: string;
    message: SendInput["message"];
    model?: string;
    effort?: Effort | null;
    /** サイドチャットはメインで最後に開いた分岐を変更しない。 */
    selectBranch?: boolean;
  }): Result.Result<
    ChatRunner,
    SendError | MessageNotFoundError | NotBranchableError
  > =>
    Result.pipe(
      registry.canStart(input.branchId),
      Result.andThen(() => chats.getChat(input.parentId)),
      Result.andThen(({ chat, messages }) => {
        const fork = messages.find(
          (m) => m.id === input.messageId && m.role === "assistant",
        );
        if (fork === undefined) {
          return Result.fail(
            new MessageNotFoundError({ messageId: input.messageId }),
          );
        }
        const forkSessionId = chat.sessionId ?? chat.forkSessionId;
        const forkFromUuid = fork.sdkUuid;
        if (forkFromUuid === null || forkSessionId === null) {
          return Result.fail(
            new NotBranchableError({ messageId: input.messageId }),
          );
        }
        return Result.pipe(
          contextFor(chat, input.message.parts),
          Result.andThen((context) =>
            Result.pipe(
              chats.createBranch({
                id: input.branchId,
                parent: chat,
                forkMessageId: fork.id,
                upToSeq: fork.seq,
                branchTitle: makeTitle(textOf(input.message.parts)),
                forkSessionId,
                forkFromUuid,
                model: input.model ?? chat.model,
                effort:
                  input.effort === undefined
                    ? chat.effort
                    : (input.effort ?? null),
                selectBranch: input.selectBranch ?? true,
              }),
              Result.map((created) => ({ created, context })),
            ),
          ),
        );
      }),
      Result.andThen(({ created, context }) =>
        Result.pipe(
          chats.saveMessage(created.id, {
            id: input.message.id,
            role: "user",
            parts: input.message.parts,
          }),
          Result.andThen(() =>
            startGeneration({
              chatId: created.id,
              model: created.model,
              effort: (created.effort as Effort | null) ?? null,
              ...resumeOf(created),
              content: toUserContent(input.message.parts),
              projectId: created.projectId,
              question: textOf(input.message.parts),
              context,
            }),
          ),
        ),
      ),
      Result.inspect((runner) => trackStatus(runner)),
    );

  /** 生成中なら何もしない（メッセージを消す前に確かめる）。 */
  const ensureIdle = (
    chatId: string,
  ): Result.Result<void, ChatAlreadyRunningError | TooManyRunnersError> =>
    registry.canStart(chatId);

  /**
   * messages[index]（ユーザー発話）以降を消して、その発話から生成し直す。
   * 直前のターンの最後の assistant uuid から fork するので、元のセッションは残る。
   */
  const restartFrom = (
    chat: ChatRow,
    messages: MessageRow[],
    index: number,
    userMessage: { id: string; parts: ChatUIMessage["parts"] },
  ): Result.Result<ChatRunner, SendError | NothingToRegenerateError> => {
    const target = messages[index];
    if (target === undefined) {
      return Result.fail(new NothingToRegenerateError());
    }
    const context = contextFor(chat, userMessage.parts);
    if (Result.isFailure(context)) return context;
    const forkPoint = findForkPoint(messages, index);
    return Result.pipe(
      chats.deleteMessagesFrom(chat.id, target.seq),
      Result.andThen(() =>
        chats.saveMessage(chat.id, {
          id: userMessage.id,
          role: "user",
          parts: userMessage.parts,
        }),
      ),
      Result.andThen(() =>
        startGeneration({
          chatId: chat.id,
          model: chat.model,
          effort: (chat.effort as Effort | null) ?? null,
          // 分岐点が無ければ（最初の発話からやり直すなら）新しいセッションにする。
          // 分岐でまだ自分のセッションが無ければ、分岐元のセッションから fork する
          sessionId:
            forkPoint === undefined
              ? null
              : (chat.sessionId ?? chat.forkSessionId),
          content: toUserContent(userMessage.parts),
          projectId: chat.projectId,
          question: textOf(userMessage.parts),
          context: context.value,
          ...(forkPoint === undefined
            ? {}
            : { resumeSessionAt: forkPoint, forkSession: true }),
        }),
      ),
      Result.inspect((runner) => trackStatus(runner)),
    );
  };

  /** 最後の応答を作り直す。 */
  const regenerate = (
    chatId: string,
  ): Result.Result<ChatRunner, SendError | NothingToRegenerateError> =>
    Result.pipe(
      ensureIdle(chatId),
      Result.andThen(() => chats.getChat(chatId)),
      Result.andThen(({ chat, messages }) => {
        const index = messages.findLastIndex((m) => m.role === "user");
        const user = messages[index];
        if (user === undefined) {
          return Result.fail(new NothingToRegenerateError());
        }
        return restartFrom(chat, messages, index, {
          id: user.id,
          parts: user.parts as ChatUIMessage["parts"],
        });
      }),
    );

  /**
   * ユーザー発話を書き換えて、そこから生成し直す。以降のメッセージは消える。
   * 書き換えるのは本文だけで、添付した画像はそのまま送る。
   */
  const edit = (input: {
    chatId: string;
    messageId: string;
    parts: ChatUIMessage["parts"];
  }): Result.Result<
    ChatRunner,
    SendError | MessageNotFoundError | NothingToRegenerateError
  > =>
    Result.pipe(
      ensureIdle(input.chatId),
      Result.andThen(() => chats.getChat(input.chatId)),
      Result.andThen(({ chat, messages }) => {
        const index = messages.findIndex(
          (m) => m.id === input.messageId && m.role === "user",
        );
        if (index < 0) {
          return Result.fail(
            new MessageNotFoundError({ messageId: input.messageId }),
          );
        }
        const original = messages[index]?.parts as ChatUIMessage["parts"];
        return restartFrom(chat, messages, index, {
          id: input.messageId,
          // 書き換えるのは本文だけ。画像と引用はそのまま
          parts: [
            ...original.filter((part) => part.type !== "text"),
            ...input.parts,
          ],
        });
      }),
    );

  const trackStatus = (runner: ChatRunner) => {
    chats.setStatus(runner.chatId, "running");
    runner.onFinish(() => {
      const chunks = runner.snapshot();
      const failed = chunks.some(
        (chunk: UIMessageChunk) => chunk.type === "error",
      );
      const aborted = chunks.some(
        (chunk: UIMessageChunk) => chunk.type === "abort",
      );
      chats.setStatus(runner.chatId, failed ? "error" : "idle");
      const outcome = failed ? "error" : aborted ? "aborted" : "success";
      // Runner の後始末が終わってから次の予約を送れるよう、少し遅らせる
      setTimeout(() => deps.onRunnerFinish?.(runner.chatId, outcome), 0);
    });
  };

  return {
    send,
    sendToWikiPage,
    branch,
    regenerate,
    edit,
    startGeneration,
    trackStatus,
    /** 生成中なら Runner を返す。無ければ undefined。 */
    reconnect: (chatId: string): ChatRunner | undefined => registry.get(chatId),
    stop: (chatId: string): boolean => {
      approvals.denyAll(chatId);
      return registry.stop(chatId);
    },
  };
};

export type ChatService = ReturnType<typeof createChatService>;
