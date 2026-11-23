import { eventIterator, os } from "@orpc/server";
import { Result } from "@praha/byethrow";
import type { InferUIMessageChunk } from "ai";
import * as z from "zod";
import type { ApprovalBroker } from "./chat/approval-broker.ts";
import { checkImagePart, MAX_IMAGES_PER_MESSAGE } from "./chat/attachments.ts";
import type { ChatService, ChatUIMessage } from "./chat/chat-service.ts";
import type { ClaudeStatusHolder } from "./claude/status.ts";
import type { ChatRepository, DatabaseError } from "./db/chat-repository.ts";
import type {
  ProjectNotFoundError,
  ProjectRepository,
} from "./db/project-repository.ts";
import {
  type ChatRow,
  type MessageRow,
  PROJECT_STATUSES,
  type ProjectLinkRow,
  type ProjectRow,
  type WikiPageRow,
} from "./db/schema.ts";
import type { WikiRepository } from "./db/wiki-repository.ts";
import { type OrpcErrorCodeMap, unwrapForOrpc } from "./errors/index.ts";
import { version } from "./version.ts";

/** oRPC ハンドラに渡すコンテキスト。 */
export type RouterContext = {
  chats: ChatRepository;
  projects: ProjectRepository;
  wiki: WikiRepository;
  chatService: ChatService;
  approvals: ApprovalBroker;
  claude: ClaudeStatusHolder;
  /** 新しい会話の作業ディレクトリ（起動時のカレントディレクトリ）。 */
  cwd: string;
};

export const base = os.$context<RouterContext>();

const ERROR_CODES: OrpcErrorCodeMap = {
  ChatNotFoundError: "NOT_FOUND",
  ProjectNotFoundError: "NOT_FOUND",
  ProjectLinkNotFoundError: "NOT_FOUND",
  WikiPageNotFoundError: "NOT_FOUND",
  ChatAlreadyRunningError: "CONFLICT",
  TooManyRunnersError: "TOO_MANY_REQUESTS",
  ApprovalNotFoundError: "NOT_FOUND",
  MessageNotFoundError: "NOT_FOUND",
  NothingToRegenerateError: "BAD_REQUEST",
};

/** クライアントに流すチャンク（承認要求の data パーツを含む）。 */
export type ChatChunk = InferUIMessageChunk<ChatUIMessage>;

const chunkIterator = eventIterator(z.custom<ChatChunk>());

/** ChatRunner は UIMessageChunk を扱う。ChatService が流すのは ChatChunk だけなので型を絞る。 */
const subscribe = (
  runner: { subscribe: (signal?: AbortSignal) => AsyncGenerator<unknown> },
  signal: AbortSignal | undefined,
) => runner.subscribe(signal) as AsyncGenerator<ChatChunk, void>;

/** クライアントに返す会話。 */
export type ChatDto = Pick<
  ChatRow,
  | "id"
  | "projectId"
  | "title"
  | "model"
  | "effort"
  | "cwd"
  | "status"
  | "createdAt"
  | "updatedAt"
> & { hasSession: boolean };

/** クライアントに返すメッセージ（UIMessage の形）。 */
export type MessageDto = {
  id: string;
  role: MessageRow["role"];
  parts: unknown[];
  metadata: unknown;
};

const toChatDto = (row: ChatRow): ChatDto => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  model: row.model,
  effort: row.effort,
  cwd: row.cwd,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  hasSession: row.sessionId !== null,
});

const toMessageDto = (row: MessageRow): MessageDto => ({
  id: row.id,
  role: row.role,
  parts: row.parts,
  metadata: row.metadata ?? undefined,
});

/** クライアントに返すプロジェクト。 */
export type ProjectDto = Pick<
  ProjectRow,
  | "id"
  | "name"
  | "autoTerms"
  | "status"
  | "progressNote"
  | "nextAction"
  | "progressUpdatedAt"
  | "createdAt"
>;

const toProjectDto = (row: ProjectRow): ProjectDto => ({
  id: row.id,
  name: row.name,
  autoTerms: row.autoTerms,
  status: row.status,
  progressNote: row.progressNote,
  nextAction: row.nextAction,
  progressUpdatedAt: row.progressUpdatedAt,
  createdAt: row.createdAt,
});

/** projectId が指定されていれば、そのプロジェクトがあることを確かめる。 */
const requireProject = (
  context: RouterContext,
  projectId: string | null | undefined,
): Result.Result<void, ProjectNotFoundError | DatabaseError> =>
  projectId === null || projectId === undefined
    ? Result.succeed()
    : Result.pipe(
        context.projects.getProject(projectId),
        Result.map(() => undefined),
      );

/** クライアントに返す関連リンク。 */
export type ProjectLinkDto = Pick<
  ProjectLinkRow,
  "id" | "projectId" | "url" | "label"
>;

const toProjectLinkDto = (row: ProjectLinkRow): ProjectLinkDto => ({
  id: row.id,
  projectId: row.projectId,
  url: row.url,
  label: row.label,
});

/** 関連リンクの入力。URL は http / https だけ。表示名は空なら null（URL を表示する）。 */
const projectLinkInput = z.object({
  url: z
    .string()
    .trim()
    .max(2000)
    .url()
    .refine(
      (url) => URL.canParse(url) && /^https?:$/.test(new URL(url).protocol),
      "http または https の URL を入力してください。",
    ),
  label: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((label) => (label === "" || label === undefined ? null : label)),
});

/** クライアントに返す Wiki ページ。 */
export type WikiPageDto = Pick<
  WikiPageRow,
  | "id"
  | "projectId"
  | "title"
  | "aliases"
  | "body"
  | "origin"
  | "sourceChatId"
  | "sourceMessageId"
  | "updatedAt"
>;

const toWikiPageDto = (row: WikiPageRow): WikiPageDto => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  aliases: row.aliases,
  body: row.body,
  origin: row.origin,
  sourceChatId: row.sourceChatId,
  sourceMessageId: row.sourceMessageId,
  updatedAt: row.updatedAt,
});

const wikiPageInput = z.object({
  title: z.string().trim().min(1).max(200),
  /** 空・重複を除く。 */
  aliases: z
    .array(z.string().trim().max(100))
    .max(20)
    .transform((aliases) => [...new Set(aliases.filter((a) => a !== ""))]),
  body: z.string().max(100_000),
});

const chatId = z.object({ id: z.string().min(1) });
const projectName = z.string().trim().min(1).max(100);

const userMessage = z.object({
  id: z.string().min(1),
  role: z.literal("user"),
  parts: z
    .array(z.object({ type: z.string() }).passthrough())
    .min(1)
    .superRefine((parts, ctx) => {
      const hasText = parts.some(
        (part) =>
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.trim() !== "",
      );
      const files = parts.filter((part) => part.type === "file");
      if (!hasText && files.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "message must contain text or images",
        });
      }
      if (files.length > MAX_IMAGES_PER_MESSAGE) {
        ctx.addIssue({
          code: "custom",
          message: `画像は 1 つの発話に ${MAX_IMAGES_PER_MESSAGE} 枚まで添付できます。`,
        });
      }
      for (const file of files) {
        const problem = checkImagePart({
          mediaType: file.mediaType,
          url: file.url,
        });
        if (problem !== undefined) {
          ctx.addIssue({ code: "custom", message: problem });
        }
      }
    }),
});

export const router = {
  system: {
    /** サーバが動いていて、トークンが正しいかを確かめる。 */
    ping: base.handler(() => ({ ok: true as const, version })),
    /** Claude Code の状態（インストール・バージョン・アカウント種別・モデル一覧）。 */
    status: base.handler(({ context }) => ({
      version,
      cwd: context.cwd,
      claude: context.claude.get(),
    })),
  },
  projects: {
    list: base.handler(async ({ context }) =>
      (await unwrapForOrpc(context.projects.listProjects(), ERROR_CODES)).map(
        toProjectDto,
      ),
    ),
    create: base
      .input(z.object({ name: projectName }))
      .handler(async ({ context, input }) =>
        toProjectDto(
          await unwrapForOrpc(
            context.projects.createProject({ name: input.name }),
            ERROR_CODES,
          ),
        ),
      ),
    rename: base
      .input(z.object({ id: z.string().min(1), name: projectName }))
      .handler(async ({ context, input }) =>
        toProjectDto(
          await unwrapForOrpc(
            context.projects.renameProject(input.id, input.name),
            ERROR_CODES,
          ),
        ),
      ),
    /** 進捗（状態・進捗メモ・次にやること）を更新する。指定した項目だけを変える。 */
    updateProgress: base
      .input(
        z.object({
          id: z.string().min(1),
          status: z.enum(PROJECT_STATUSES).optional(),
          progressNote: z.string().max(20_000).optional(),
          nextAction: z.string().trim().max(500).optional(),
        }),
      )
      .handler(async ({ context, input }) =>
        toProjectDto(
          await unwrapForOrpc(
            context.projects.updateProgress(input.id, {
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.progressNote === undefined
                ? {}
                : { progressNote: input.progressNote }),
              ...(input.nextAction === undefined
                ? {}
                : { nextAction: input.nextAction }),
            }),
            ERROR_CODES,
          ),
        ),
      ),
    /** 回答からの用語ページの自動作成を切り替える。 */
    setAutoTerms: base
      .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
      .handler(async ({ context, input }) =>
        toProjectDto(
          await unwrapForOrpc(
            context.projects.setAutoTerms(input.id, input.enabled),
            ERROR_CODES,
          ),
        ),
      ),
    /** プロジェクトを消す。所属していた会話は消さず、未所属に戻る。 */
    delete: base
      .input(z.object({ id: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(
          context.projects.deleteProject(input.id),
          ERROR_CODES,
        );
        return { id: input.id };
      }),
  },
  links: {
    /** プロジェクトの関連リンク（登録した順）。 */
    list: base
      .input(z.object({ projectId: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        (
          await unwrapForOrpc(
            Result.pipe(
              requireProject(context, input.projectId),
              Result.andThen(() => context.projects.listLinks(input.projectId)),
            ),
            ERROR_CODES,
          )
        ).map(toProjectLinkDto),
      ),
    create: base
      .input(projectLinkInput.extend({ projectId: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        toProjectLinkDto(
          await unwrapForOrpc(
            Result.pipe(
              requireProject(context, input.projectId),
              Result.andThen(() =>
                context.projects.createLink({
                  projectId: input.projectId,
                  url: input.url,
                  label: input.label,
                }),
              ),
            ),
            ERROR_CODES,
          ),
        ),
      ),
    update: base
      .input(projectLinkInput.extend({ id: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        toProjectLinkDto(
          await unwrapForOrpc(
            context.projects.updateLink(input.id, {
              url: input.url,
              label: input.label,
            }),
            ERROR_CODES,
          ),
        ),
      ),
    /** リンクの登録を消す（リンク先には何もしない）。 */
    delete: base
      .input(z.object({ id: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(context.projects.deleteLink(input.id), ERROR_CODES);
        return { id: input.id };
      }),
  },
  wiki: {
    /** プロジェクトの Wiki ページ（タイトル順）。 */
    list: base
      .input(z.object({ projectId: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        (
          await unwrapForOrpc(
            Result.pipe(
              requireProject(context, input.projectId),
              Result.andThen(() => context.wiki.listPages(input.projectId)),
            ),
            ERROR_CODES,
          )
        ).map(toWikiPageDto),
      ),
    get: base
      .input(z.object({ id: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        toWikiPageDto(
          await unwrapForOrpc(context.wiki.getPage(input.id), ERROR_CODES),
        ),
      ),
    create: base
      .input(wikiPageInput.extend({ projectId: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        toWikiPageDto(
          await unwrapForOrpc(
            Result.pipe(
              requireProject(context, input.projectId),
              Result.andThen(() => context.wiki.createPage(input)),
            ),
            ERROR_CODES,
          ),
        ),
      ),
    update: base
      .input(wikiPageInput.extend({ id: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        toWikiPageDto(
          await unwrapForOrpc(
            context.wiki.updatePage(input.id, {
              title: input.title,
              aliases: input.aliases,
              body: input.body,
            }),
            ERROR_CODES,
          ),
        ),
      ),
    /** ページを消す。過去の回答の本文はそのまま読める。 */
    delete: base
      .input(z.object({ id: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(context.wiki.deletePage(input.id), ERROR_CODES);
        return { id: input.id };
      }),
  },
  chats: {
    list: base.handler(async ({ context }) =>
      (await unwrapForOrpc(context.chats.listChats(), ERROR_CODES)).map(
        toChatDto,
      ),
    ),
    get: base.input(chatId).handler(async ({ context, input }) => {
      const { chat, messages } = await unwrapForOrpc(
        context.chats.getChat(input.id),
        ERROR_CODES,
      );
      return { chat: toChatDto(chat), messages: messages.map(toMessageDto) };
    }),
    create: base
      .input(
        z.object({
          projectId: z.string().min(1).nullable().optional(),
          model: z.string().min(1).optional(),
          effort: z.string().min(1).nullable().optional(),
        }),
      )
      .handler(async ({ context, input }) =>
        toChatDto(
          await unwrapForOrpc(
            Result.pipe(
              requireProject(context, input.projectId),
              Result.andThen(() =>
                context.chats.createChat({
                  cwd: context.cwd,
                  projectId: input.projectId ?? null,
                  model: input.model,
                  effort: input.effort,
                }),
              ),
            ),
            ERROR_CODES,
          ),
        ),
      ),
    /** 会話の所属プロジェクトを変える（null で未所属に戻す）。過去のメッセージとセッションはそのまま。 */
    setProject: base
      .input(chatId.extend({ projectId: z.string().min(1).nullable() }))
      .handler(async ({ context, input }) =>
        toChatDto(
          await unwrapForOrpc(
            Result.pipe(
              requireProject(context, input.projectId),
              Result.andThen(() =>
                context.chats.setProject(input.id, input.projectId),
              ),
            ),
            ERROR_CODES,
          ),
        ),
      ),
    rename: base
      .input(chatId.extend({ title: z.string().trim().min(1).max(200) }))
      .handler(async ({ context, input }) =>
        toChatDto(
          await unwrapForOrpc(
            context.chats.updateChat(input.id, { title: input.title }),
            ERROR_CODES,
          ),
        ),
      ),
    delete: base.input(chatId).handler(async ({ context, input }) => {
      // 生成中なら止めてから消す
      context.chatService.stop(input.id);
      await unwrapForOrpc(context.chats.deleteChat(input.id), ERROR_CODES);
      return { id: input.id };
    }),
  },
  chat: {
    /**
     * ユーザー発話を保存して生成を始め、UIMessageChunk を流す。
     * 接続が切れても生成は続く（chat.reconnect で続きを受け取れる）。
     */
    send: base
      .input(
        z.object({
          chatId: z.string().min(1),
          message: userMessage,
          model: z.string().min(1).optional(),
          effort: z
            .enum(["low", "medium", "high", "xhigh", "max"])
            .nullable()
            .optional(),
        }),
      )
      .output(chunkIterator)
      .handler(async ({ context, input, signal }) => {
        // 失敗（存在しない会話・生成中など）は、ストリームを返す前に呼び出しのエラーにする
        const runner = await unwrapForOrpc(
          context.chatService.send({
            chatId: input.chatId,
            message: input.message as Parameters<
              ChatService["send"]
            >[0]["message"],
            model: input.model,
            effort: input.effort,
          }),
          ERROR_CODES,
        );
        return subscribe(runner, signal);
      }),
    /** 最後の応答を作り直す（直前のターンから fork する）。 */
    regenerate: base
      .input(z.object({ chatId: z.string().min(1) }))
      .output(chunkIterator)
      .handler(async ({ context, input, signal }) => {
        const runner = await unwrapForOrpc(
          context.chatService.regenerate(input.chatId),
          ERROR_CODES,
        );
        return subscribe(runner, signal);
      }),
    /** ユーザー発話を書き換えて、そこから生成し直す。以降のメッセージは消える。 */
    edit: base
      .input(
        z.object({
          chatId: z.string().min(1),
          messageId: z.string().min(1),
          text: z.string().trim().min(1),
        }),
      )
      .output(chunkIterator)
      .handler(async ({ context, input, signal }) => {
        const runner = await unwrapForOrpc(
          context.chatService.edit({
            chatId: input.chatId,
            messageId: input.messageId,
            parts: [{ type: "text", text: input.text }],
          }),
          ERROR_CODES,
        );
        return subscribe(runner, signal);
      }),
    /** 生成中なら最初から流し直す。生成中でなければすぐに終わる。 */
    reconnect: base
      .input(z.object({ chatId: z.string().min(1) }))
      .output(chunkIterator)
      .handler(async function* ({ context, input, signal }) {
        const runner = context.chatService.reconnect(input.chatId);
        if (runner !== undefined) {
          yield* subscribe(runner, signal);
        }
      }),
    /** 生成を止める。 */
    stop: base
      .input(z.object({ chatId: z.string().min(1) }))
      .handler(({ context, input }) => ({
        stopped: context.chatService.stop(input.chatId),
      })),
  },
  approvals: {
    /** ツール実行の承認要求に答える。 */
    respond: base
      .input(
        z.object({
          chatId: z.string().min(1),
          approvalId: z.string().min(1),
          behavior: z.enum(["allow", "deny"]),
          message: z.string().max(1000).optional(),
        }),
      )
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(context.approvals.respond(input), ERROR_CODES);
        return { ok: true as const };
      }),
  },
};

export type Router = typeof router;
