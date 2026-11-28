import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
  CanUseTool,
  McpServerConfig,
  SDKControlGetContextUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
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
import type { AgentId, ChatRow, MessageRow } from "../db/schema.ts";
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
import { citationsOfMessage } from "./answer-citations.ts";
import type { AnswerFinished } from "./answer-summary.ts";
import type { ApprovalBroker, ApprovalData } from "./approval-broker.ts";
import type { ChatRunner } from "./chat-runner.ts";
import { type AnswerCitations, CITATION_INSTRUCTIONS } from "./citations.ts";
import { toContextUsage } from "./context-usage.ts";
import { toUserErrorMessage } from "./error-messages.ts";
import { type QuoteData, quotesOf, quoteText } from "./quote.ts";
import type {
  ChatAlreadyRunningError,
  RunnerRegistry,
  TooManyRunnersError,
} from "./runner-registry.ts";
import type { TaskContextBuilder } from "./task-context.ts";
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

/** Claude Code 以外の会話で、途中からのやり直し（再生成・編集）を頼まれたとき（#265）。 */
export class UnsupportedForAgentError extends ErrorFactory({
  name: "UnsupportedForAgentError",
  message: (fields) => fields.detail,
  fields: ErrorFactory.fields<{ detail: string }>(),
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
  wiki?: Omit<WikiContext, "text" | "taskId"> & {
    taskId?: string;
    /** 「プロジェクト」を「タスク」に改名する前に保存した回答の taskId。 */
    projectId?: string;
  };
  /** 回答の要約（閉じた回答に出す）。回答のあとに作るので、後から付く。 */
  summary?: string;
  /** 本文の印に番号を付けた出典（#258）。回答を保存するときに付ける。 */
  citations?: AnswerCitations;
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
 * 送信で resume するセッション。自分のセッションがあればそれを、分岐した会話でまだ無ければ
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
 * 終わったら（成功・中断・エラーとも）回答を DB に保存する。
 */
export const createChatService = (deps: {
  chats: ChatRepository;
  registry: RunnerRegistry;
  approvals: ApprovalBroker;
  /**
   * 会話ごとの canUseTool（と MCP サーバ）を差し込んだモデルを返す。
   * agent は会話に使う AI（#265）。Claude Code 以外では MCP サーバ・コンテキストの使用量は使わない。
   */
  languageModel: (
    modelId: string,
    options: {
      agent: AgentId;
      canUseTool: CanUseTool;
      mcpServers?: Record<string, McpServerConfig>;
      /** 回答のあとに取れたコンテキストの使用量（#245）。 */
      onContextUsage?: (usage: SDKControlGetContextUsageResponse) => void;
      /** システムプロンプトに足す指示（出典の付け方。#258）。 */
      appendSystemPrompt?: string;
    },
  ) => LanguageModelV4;
  /**
   * タスクの会話で、Claude がタスクの Wiki を読み書きする MCP サーバ。
   * Wiki ページにひも付く会話なら pageId を渡す。無い・undefined を返すときは、ツールなしで生成する。
   */
  wikiTools?: (scope: {
    taskId: string;
    pageId: string | null;
    /** 変更した会話と、この回答での変更のまとまり（版に残す。#166）。 */
    chatId: string;
    batchId: string;
    question: string;
  }) => Record<string, McpServerConfig> | undefined;
  /**
   * 回答が終わったとき（中断・エラーを含む）に、その回答で Claude が Wiki に加えた変更
   * （batchId）に回答の id を付ける（回答ごとに元に戻すのに使う。#166）。
   */
  onWikiBatchFinish?: (batchId: string, messageId: string) => void;
  /**
   * タスクの会話で、Claude が所属タスクの進捗と関連リンクを更新する MCP サーバ（#187）。
   * 更新先は会話の所属タスクに決まる。タスクに属さない会話には渡さない。
   */
  taskTools?: (scope: {
    taskId: string;
  }) => Record<string, McpServerConfig> | undefined;
  /** タスクの会話で、質問に関係する Wiki ページを参照資料にする。 */
  wikiContext?: WikiContextBuilder;
  /**
   * タスクの会話で、タスクと環境の保存情報を参照情報にする（#186）。
   * 生成を始めるたびに、その時点で会話が属するタスクから読み直す。
   */
  taskContext?: TaskContextBuilder;
  readWikiPage?: WikiPageReader;
  /** タスクが属する環境のディレクトリ（追加のディレクトリとして渡す）。 */
  directoriesOf?: (taskId: string) => string[] | undefined;
  /**
   * タスクの会話で回答が最後まで終わったとき（中断・エラーを除く）に呼ぶ。
   * 用語ページの自動作成（#80）に使う。回答の保存のあとに呼び、結果は待たない。
   */
  onAnswerComplete?: (event: AnswerCompleted) => void;
  /**
   * 回答が最後まで終わったとき（中断・エラーを除く。タスクに属さない会話も含む）に呼ぶ。
   * 回答の要約に使う。回答の保存のあとに呼び、結果は待たない。
   */
  onAnswerFinish?: (event: AnswerFinished) => void;
  /**
   * 「このページについて質問」で Wiki ページの会話を新しく作ったとき（ページ名を仮のタイトルにしている）。
   * 最初の回答のあとにタイトルを付ける（#161）のに使う。
   */
  onWikiChatCreated?: (chat: ChatRow) => void;
  /**
   * 回答が正常に終わって保存されたとき（中断・エラーを除く。本文の無い回答も含む）に、回答ごとに 1 回呼ぶ。
   * 回答の完了の通知に使う（#264）。
   */
  onAnswerSaved?: (event: { chatId: string; messageId: string }) => void;
  /** 会話の生成が始まったとき（ゴールの実行の進捗の更新に使う。#198）。 */
  onRunnerStart?: (chatId: string) => void;
  /** 会話の生成が終わったとき（予約したメッセージの送信に使う。#102）。 */
  onRunnerFinish?: (
    chatId: string,
    outcome: "success" | "aborted" | "error",
  ) => void;
}) => {
  const { chats, registry, approvals } = deps;

  const readWikiPage: WikiPageReader = (taskId, pageId) =>
    deps.readWikiPage?.(taskId, pageId) ??
    Result.fail(new WikiPageUnavailableError());

  /**
   * 会話の作業ディレクトリと、追加のディレクトリ。作業ディレクトリは会話を作ったときのまま
   * （セッションはディレクトリごとに保存されるので、変えると resume できない）。
   * 追加のディレクトリは、送信のたびに環境の設定から読む。
   */
  const workspaceOf = (chat: Pick<ChatRow, "cwd" | "taskId">) => ({
    cwd: chat.cwd,
    additionalDirectories: (chat.taskId === null
      ? []
      : (deps.directoriesOf?.(chat.taskId) ?? [])
    ).filter((dir) => dir !== chat.cwd),
  });

  /** ページにひも付く会話は、ページを参照できない場合に生成を始めない。 */
  const contextFor = (chat: ChatRow, parts: ChatUIMessage["parts"]) => {
    const { taskId, wikiPageId } = chat;
    const question = textOf(parts);
    if (wikiPageId === null) {
      return Result.succeed(
        taskId === null ? undefined : deps.wikiContext?.(taskId, question),
      );
    }
    if (taskId === null) return Result.fail(new WikiPageUnavailableError());
    return Result.pipe(
      readWikiPage(taskId, wikiPageId),
      Result.map((page) => wikiPageContext(taskId, page, question)),
    );
  };

  const startGeneration = (params: {
    chatId: string;
    /** 会話に使う AI（#265）。省くと Claude Code。 */
    agent?: AgentId;
    model: string;
    effort: Effort | null;
    sessionId: string | null;
    content: UserContent;
    /** 会話の所属タスク（回答後の用語ページ作成に使う）。 */
    taskId: string | null;
    /** 会話がひも付く Wiki ページ（Wiki のツールに、会話の対象のページとして伝える）。 */
    wikiPageId: string | null;
    /** 作業ディレクトリ（会話を作ったときに決まる。セッションの resume に要る）。 */
    cwd: string;
    /** 作業ディレクトリのほかに扱えるディレクトリ（環境の設定）。 */
    additionalDirectories: string[];
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
      /** この回答で Claude が Wiki に加えた変更のまとまり。 */
      const wikiBatchId = crypto.randomUUID();
      return createUIMessageStream<ChatUIMessage>({
        generateId,
        execute: ({ writer }) => {
          const canUseTool = approvals.createCanUseTool(
            params.chatId,
            (chunk) => writer.write(chunk),
          );
          // タスクの会話では、Claude がタスクの Wiki と、タスクの進捗・関連リンクを読み書きできる
          const servers =
            params.taskId === null
              ? []
              : [
                  deps.wikiTools?.({
                    taskId: params.taskId,
                    pageId: params.wikiPageId,
                    chatId: params.chatId,
                    batchId: wikiBatchId,
                    question: params.question,
                  }),
                  deps.taskTools?.({ taskId: params.taskId }),
                ].filter((server) => server !== undefined);
          const mcpServers =
            servers.length === 0 ? undefined : Object.assign({}, ...servers);
          // タスクの情報と Wiki の参照資料は、質問とは別のブロックで渡す（DB の発話には保存しない）。
          // スラッシュコマンド（`/goal …` など）は、Claude Code が解釈できるようにそのまま送る（#198）
          const slashCommand = params.question.trimStart().startsWith("/");
          const context = slashCommand
            ? ""
            : [
                params.taskId === null
                  ? undefined
                  : deps.taskContext?.(params.taskId),
                params.context?.text,
              ]
                .filter((text) => text !== undefined && text.trim() !== "")
                .join("\n\n");
          const result = streamText({
            model: deps.languageModel(params.model, {
              agent: params.agent ?? "claude-code",
              canUseTool,
              ...(mcpServers === undefined ? {} : { mcpServers }),
              // 根拠にした資料を、本文の該当箇所に出典として付けてもらう（#258）
              appendSystemPrompt: CITATION_INSTRUCTIONS,
              // 最後に取れた使用量を会話ごとに残し、開き直しても見られるようにする（#245）
              onContextUsage: (usage) => {
                chats.setContextUsage(
                  params.chatId,
                  toContextUsage(usage, new Date()),
                );
              },
            }),
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
                ...(context === "" ? {} : { context }),
                cwd: params.cwd,
                ...(params.additionalDirectories.length === 0
                  ? {}
                  : { additionalDirectories: params.additionalDirectories }),
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
                            taskId: params.context.taskId,
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
          try {
            deps.onWikiBatchFinish?.(wikiBatchId, responseMessage.id);
          } catch {
            // 履歴の記録は回答に影響させない
          }
          // 本文の印に結び付いた出典を、回答と一緒に残す（再読み込み・分岐しても同じ記述に付く。#258）
          const citations = citationsOfMessage(responseMessage, params.taskId);
          const metadata = {
            ...responseMessage.metadata,
            ...(isAborted ? { aborted: true } : {}),
            ...(citations.sources.length > 0 ? { citations } : {}),
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
          if (!isAborted && !failed && responseMessage.parts.length > 0) {
            try {
              deps.onAnswerSaved?.({
                chatId: params.chatId,
                messageId: responseMessage.id,
              });
            } catch {
              // 通知は回答に影響させない
            }
          }
          const answer = responseMessage.parts
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n\n");
          if (!isAborted && !failed && answer.trim() !== "") {
            try {
              deps.onAnswerFinish?.({
                chatId: params.chatId,
                messageId: responseMessage.id,
                question: params.question,
                answer,
              });
            } catch {
              // 要約は回答に影響させない
            }
          }
          if (
            !isAborted &&
            !failed &&
            params.taskId !== null &&
            answer.trim() !== ""
          ) {
            try {
              deps.onAnswerComplete?.({
                chatId: params.chatId,
                taskId: params.taskId,
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
        // 最初の発話で付けたタイトルは、スレッド（会話のまとまり）で共有する
        if (titled && chat.groupId !== chat.id) {
          chats.setGroupTitle(chat.groupId, chat.title);
        }
      }),
      Result.andThen((chat) =>
        startGeneration({
          chatId: chat.id,
          agent: chat.agent,
          model: chat.model,
          effort: (chat.effort as Effort | null) ?? null,
          ...resumeOf(chat),
          content: toUserContent(input.message.parts),
          taskId: chat.taskId,
          wikiPageId: chat.wikiPageId,
          ...workspaceOf(chat),
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
      taskId: string;
      pageId: string;
      cwd: string;
    },
  ): Result.Result<ChatRunner, SendError> => {
    const id = crypto.randomUUID();
    return Result.pipe(
      registry.canStart(id),
      Result.andThen(() => readWikiPage(input.taskId, input.pageId)),
      Result.andThen((page) =>
        Result.pipe(
          chats.getOrCreateWikiChat({
            id,
            taskId: input.taskId,
            wikiPageId: page.id,
            title: page.title,
            cwd: input.cwd,
          }),
          Result.inspect((chat) => {
            if (chat.id !== id) return;
            try {
              deps.onWikiChatCreated?.(chat);
            } catch {
              // タイトルの自動生成は送信に影響させない
            }
          }),
          Result.andThen((chat) =>
            Result.pipe(
              registry.canStart(chat.id),
              Result.andThen(() =>
                sendToChat(
                  chat,
                  input,
                  wikiPageContext(
                    input.taskId,
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
   * 分岐して新しい会話を作り、最初の発話から生成を始める（#76）。分岐元のセッションを分岐点まで巻き戻して
   * fork し、新しいセッションを新しい会話に保存する。分岐元の会話はそのまま残る。
   */
  const branch = (input: {
    parentId: string;
    /** 分岐点にする、分岐元の完了した assistant メッセージ。 */
    messageId: string;
    /** 新しい会話の id（クライアントが決める）。 */
    branchId: string;
    message: SendInput["message"];
    model?: string;
    effort?: Effort | null;
    /** サイドチャットはメインで最後に開いた会話を変更しない。 */
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
              agent: created.agent,
              model: created.model,
              effort: (created.effort as Effort | null) ?? null,
              ...resumeOf(created),
              content: toUserContent(input.message.parts),
              taskId: created.taskId,
              wikiPageId: created.wikiPageId,
              ...workspaceOf(created),
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
  ): Result.Result<
    ChatRunner,
    SendError | NothingToRegenerateError | UnsupportedForAgentError
  > => {
    const target = messages[index];
    if (target === undefined) {
      return Result.fail(new NothingToRegenerateError());
    }
    const context = contextFor(chat, userMessage.parts);
    if (Result.isFailure(context)) return context;
    const forkPoint = findForkPoint(messages, index);
    // Claude Code 以外では、途中の地点からセッションを巻き戻せない（最初の発話からなら新しく始められる）
    if (chat.agent !== "claude-code" && forkPoint === undefined && index > 0) {
      return Result.fail(
        new UnsupportedForAgentError({
          detail:
            "この AI の会話では、途中の発話からの再生成・編集にまだ対応していません。新しいメッセージとして送ってください。",
        }),
      );
    }
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
          agent: chat.agent,
          model: chat.model,
          effort: (chat.effort as Effort | null) ?? null,
          // 分岐点が無ければ（最初の発話からやり直すなら）新しいセッションにする。
          // 分岐した会話でまだ自分のセッションが無ければ、分岐元のセッションから fork する
          sessionId:
            forkPoint === undefined
              ? null
              : (chat.sessionId ?? chat.forkSessionId),
          content: toUserContent(userMessage.parts),
          taskId: chat.taskId,
          wikiPageId: chat.wikiPageId,
          ...workspaceOf(chat),
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

  /** 最後の回答を作り直す。 */
  const regenerate = (
    chatId: string,
  ): Result.Result<
    ChatRunner,
    SendError | NothingToRegenerateError | UnsupportedForAgentError
  > =>
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
    | SendError
    | MessageNotFoundError
    | NothingToRegenerateError
    | UnsupportedForAgentError
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
    try {
      deps.onRunnerStart?.(runner.chatId);
    } catch {
      // 進捗の更新は生成に影響させない
    }
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
