import { eventIterator, os } from "@orpc/server";
import { Result } from "@praha/byethrow";
import type { InferUIMessageChunk } from "ai";
import * as z from "zod";
import type { ApprovalBroker } from "./chat/approval-broker.ts";
import { checkImagePart, MAX_IMAGES_PER_MESSAGE } from "./chat/attachments.ts";
import type { ChatService, ChatUIMessage } from "./chat/chat-service.ts";
import type { QueueDispatcher } from "./chat/queue-dispatcher.ts";
import type { ClaudeStatusHolder } from "./claude/status.ts";
import {
  type ChatRepository,
  type DatabaseError,
  WikiChatTaskError,
} from "./db/chat-repository.ts";
import {
  EnvironmentNotFoundError,
  type EnvironmentRepository,
  type EnvironmentSummary,
} from "./db/environment-repository.ts";
import type { QueueRepository } from "./db/queue-repository.ts";
import type { RateLimitRepository } from "./db/rate-limit-repository.ts";
import {
  type ChatRow,
  type MessageRow,
  TASK_STATUSES,
  type TaskLinkRow,
  type TaskRow,
  type WikiPageRow,
} from "./db/schema.ts";
import type { SearchRepository } from "./db/search-repository.ts";
import {
  type TaskNotFoundError,
  type TaskRepository,
  wikiIdOf,
} from "./db/task-repository.ts";
import type { WikiRepository } from "./db/wiki-repository.ts";
import { normalizeDirectories } from "./environment/directories.ts";
import type { DirectoryPicker } from "./environment/directory-picker.ts";
import { type OrpcErrorCodeMap, unwrapForOrpc } from "./errors/index.ts";
import { version } from "./version.ts";
import type { WikiPageGenerator } from "./wiki/page-generation.ts";
import { MAX_PAGE_TERM_LENGTH } from "./wiki/terms.ts";

/** oRPC ハンドラに渡すコンテキスト。 */
export type RouterContext = {
  chats: ChatRepository;
  tasks: TaskRepository;
  environments: EnvironmentRepository;
  queue: QueueRepository;
  queueDispatcher: QueueDispatcher;
  search: SearchRepository;
  rateLimits: RateLimitRepository;
  wiki: WikiRepository;
  chatService: ChatService;
  approvals: ApprovalBroker;
  claude: ClaudeStatusHolder;
  /** 回答の中の語句から Wiki のページを Claude に書かせる。 */
  generateWikiPage: WikiPageGenerator;
  /**
   * 起動時のカレントディレクトリ。タスクに属さない会話の作業ディレクトリと、
   * 環境を選ばずに作ったタスクの環境のディレクトリに使う。
   */
  cwd: string;
  /** OS のフォルダを選ぶダイアログを開く。 */
  pickDirectory: DirectoryPicker;
};

export const base = os.$context<RouterContext>();

const ERROR_CODES: OrpcErrorCodeMap = {
  ChatNotFoundError: "NOT_FOUND",
  TaskNotFoundError: "NOT_FOUND",
  EnvironmentNotFoundError: "NOT_FOUND",
  EnvironmentNotEmptyError: "CONFLICT",
  WikiNotFoundError: "NOT_FOUND",
  DirectoryNotFoundError: "BAD_REQUEST",
  RelativeDirectoryError: "BAD_REQUEST",
  DirectoryPickerUnavailableError: "SERVICE_UNAVAILABLE",
  DirectoryPickerError: "INTERNAL_SERVER_ERROR",
  TaskLinkNotFoundError: "NOT_FOUND",
  QueuedMessageNotFoundError: "NOT_FOUND",
  WikiPageNotFoundError: "NOT_FOUND",
  WikiPageUnavailableError: "NOT_FOUND",
  WikiChatTaskError: "BAD_REQUEST",
  ChatWithoutTaskError: "BAD_REQUEST",
  AnswerNotFoundError: "NOT_FOUND",
  InvalidPageTermError: "BAD_REQUEST",
  ChatAlreadyRunningError: "CONFLICT",
  TooManyRunnersError: "TOO_MANY_REQUESTS",
  ApprovalNotFoundError: "NOT_FOUND",
  MessageNotFoundError: "NOT_FOUND",
  NothingToRegenerateError: "BAD_REQUEST",
  NotBranchableError: "BAD_REQUEST",
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
  | "groupId"
  | "parentId"
  | "forkMessageId"
  | "inheritedCount"
  | "branchTitle"
  | "lastSelectedAt"
  | "taskId"
  | "wikiPageId"
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
  groupId: row.groupId,
  parentId: row.parentId,
  forkMessageId: row.forkMessageId,
  inheritedCount: row.inheritedCount,
  branchTitle: row.branchTitle,
  lastSelectedAt: row.lastSelectedAt,
  taskId: row.taskId,
  wikiPageId: row.wikiPageId,
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

/** クライアントに返すタスク。 */
export type TaskDto = Pick<
  TaskRow,
  | "id"
  | "name"
  | "autoTerms"
  | "status"
  | "progressNote"
  | "nextAction"
  | "progressUpdatedAt"
  | "createdAt"
> & {
  /** 所属する環境。 */
  environmentId: string | null;
  /** 参照する Wiki（所属する環境の Wiki）。 */
  wikiId: string;
};

const toTaskDto = (row: TaskRow): TaskDto => ({
  id: row.id,
  name: row.name,
  environmentId: row.environmentId,
  wikiId: wikiIdOf(row),
  autoTerms: row.autoTerms,
  status: row.status,
  progressNote: row.progressNote,
  nextAction: row.nextAction,
  progressUpdatedAt: row.progressUpdatedAt,
  createdAt: row.createdAt,
});

/** クライアントに返す環境。 */
export type EnvironmentDto = Pick<
  EnvironmentSummary,
  "id" | "name" | "wikiId" | "wikiName" | "directories" | "taskCount"
>;

const toEnvironmentDto = (row: EnvironmentSummary): EnvironmentDto => ({
  id: row.id,
  name: row.name,
  wikiId: row.wikiId,
  wikiName: row.wikiName,
  directories: row.directories,
  taskCount: row.taskCount,
});

/** 環境の入力。ディレクトリは 1 つ以上（先頭が作業ディレクトリ）。 */
const environmentName = z.string().trim().min(1).max(100);
const directoriesInput = z
  .array(z.string().trim().min(1).max(4096))
  .min(1)
  .max(20);

/** 環境を 1 件、一覧と同じ形（Wiki の名前・タスクの数つき）で返す。 */
const environmentDto = (
  context: RouterContext,
  environmentId: string,
): Result.Result<EnvironmentDto, EnvironmentNotFoundError | DatabaseError> =>
  Result.pipe(
    context.environments.listEnvironments(),
    Result.andThen((list) => {
      const found = list.find(
        (environment) => environment.id === environmentId,
      );
      return found === undefined
        ? Result.fail(new EnvironmentNotFoundError({ environmentId }))
        : Result.succeed(toEnvironmentDto(found));
    }),
  );

/**
 * タスクの会話の作業ディレクトリ（環境の先頭のディレクトリ）。タスクに属さない、
 * または環境にディレクトリが無ければ、起動したディレクトリ。
 */
const cwdForTask = (
  context: RouterContext,
  taskId: string | null | undefined,
): Result.Result<string, DatabaseError> =>
  taskId === null || taskId === undefined
    ? Result.succeed(context.cwd)
    : Result.pipe(
        context.environments.directoriesOfTask(taskId),
        Result.map((directories) => directories?.[0] ?? context.cwd),
      );

/** クライアントに返す Wiki（複数のタスクで共有できる）。 */
export type WikiDto = { id: string; name: string; taskCount: number };

/** taskId が指定されていれば、そのタスクがあることを確かめる。 */
const requireTask = (
  context: RouterContext,
  taskId: string | null | undefined,
): Result.Result<void, TaskNotFoundError | DatabaseError> =>
  taskId === null || taskId === undefined
    ? Result.succeed()
    : Result.pipe(
        context.tasks.getTask(taskId),
        Result.map(() => undefined),
      );

/** クライアントに返す関連リンク。 */
export type TaskLinkDto = Pick<TaskLinkRow, "id" | "taskId" | "url" | "label">;

const toTaskLinkDto = (row: TaskLinkRow): TaskLinkDto => ({
  id: row.id,
  taskId: row.taskId,
  url: row.url,
  label: row.label,
});

/** 関連リンクの入力。URL は http / https だけ。表示名は空なら null（URL を表示する）。 */
const taskLinkInput = z.object({
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
  | "wikiId"
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
  wikiId: row.wikiId,
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
const taskName = z.string().trim().min(1).max(100);
const wikiChatTarget = z.object({
  taskId: z.string().min(1),
  pageId: z.string().min(1),
});
const sendSettings = {
  model: z.string().min(1).optional(),
  effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .nullable()
    .optional(),
};

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
      for (const quote of parts.filter((part) => part.type === "data-quote")) {
        const data = quote.data as {
          text?: unknown;
          sourceMessageId?: unknown;
        };
        if (
          typeof data?.text !== "string" ||
          data.text.trim() === "" ||
          data.text.length > 20_000 ||
          typeof data.sourceMessageId !== "string"
        ) {
          ctx.addIssue({
            code: "custom",
            message: "引用の形式が正しくありません。",
          });
        }
      }
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
    /** OS のフォルダを選ぶダイアログを開き、選んだディレクトリを返す（キャンセルなら null）。 */
    pickDirectory: base.handler(async ({ context }) => ({
      path: await unwrapForOrpc(context.pickDirectory(), ERROR_CODES),
    })),
  },
  environments: {
    /** 環境（作った順）と、参照する Wiki の名前・タスクの数。 */
    list: base.handler(async ({ context }) =>
      (
        await unwrapForOrpc(
          context.environments.listEnvironments(),
          ERROR_CODES,
        )
      ).map(toEnvironmentDto),
    ),
    /** 環境を作る。wikiId を渡すとその Wiki を共有し、無ければ同じ名前の Wiki を新しく作る。 */
    create: base
      .input(
        z.object({
          name: environmentName,
          directories: directoriesInput,
          wikiId: z.string().min(1).optional(),
        }),
      )
      .handler(async ({ context, input }) =>
        unwrapForOrpc(
          Result.pipe(
            normalizeDirectories(input.directories),
            Result.andThen((directories) =>
              context.environments.createEnvironment({
                name: input.name,
                directories,
                ...(input.wikiId === undefined ? {} : { wikiId: input.wikiId }),
              }),
            ),
            Result.andThen((row) => environmentDto(context, row.id)),
          ),
          ERROR_CODES,
        ),
      ),
    /**
     * 名前・ディレクトリ・参照する Wiki を変える（指定した項目だけ）。
     * ディレクトリの先頭を変えても、作業ディレクトリは新しいスレッドからしか変わらない。
     */
    update: base
      .input(
        z.object({
          id: z.string().min(1),
          name: environmentName.optional(),
          directories: directoriesInput.optional(),
          wikiId: z.string().min(1).optional(),
        }),
      )
      .handler(async ({ context, input }) =>
        unwrapForOrpc(
          Result.pipe(
            input.directories === undefined
              ? Result.succeed(undefined)
              : normalizeDirectories(input.directories),
            Result.andThen((directories) =>
              context.environments.updateEnvironment(input.id, {
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(directories === undefined ? {} : { directories }),
                ...(input.wikiId === undefined ? {} : { wikiId: input.wikiId }),
              }),
            ),
            Result.andThen((row) => environmentDto(context, row.id)),
          ),
          ERROR_CODES,
        ),
      ),
    /** 環境を消す。タスクがあれば消さない。ほかの環境が使っていない Wiki はページごと消す。 */
    delete: base
      .input(z.object({ id: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(
          context.environments.deleteEnvironment(input.id),
          ERROR_CODES,
        );
        return { id: input.id };
      }),
  },
  tasks: {
    list: base.handler(async ({ context }) =>
      (await unwrapForOrpc(context.tasks.listTasks(), ERROR_CODES)).map(
        toTaskDto,
      ),
    ),
    /**
     * タスクを作る。environmentId を渡すとその環境に入れ、無ければタスクと同じ名前の環境
     * （起動したディレクトリと、新しい Wiki）を作って入れる。
     */
    create: base
      .input(
        z.object({
          name: taskName,
          environmentId: z.string().min(1).optional(),
        }),
      )
      .handler(async ({ context, input }) =>
        toTaskDto(
          await unwrapForOrpc(
            context.tasks.createTask({
              name: input.name,
              ...(input.environmentId === undefined
                ? { directories: [context.cwd] }
                : { environmentId: input.environmentId }),
            }),
            ERROR_CODES,
          ),
        ),
      ),
    /** タスクを別の環境に移す。Wiki は移った環境のものになり、スレッドの作業ディレクトリはそのまま。 */
    setEnvironment: base
      .input(
        z.object({ id: z.string().min(1), environmentId: z.string().min(1) }),
      )
      .handler(async ({ context, input }) =>
        toTaskDto(
          await unwrapForOrpc(
            context.tasks.setEnvironment(input.id, input.environmentId),
            ERROR_CODES,
          ),
        ),
      ),
    rename: base
      .input(z.object({ id: z.string().min(1), name: taskName }))
      .handler(async ({ context, input }) =>
        toTaskDto(
          await unwrapForOrpc(
            context.tasks.renameTask(input.id, input.name),
            ERROR_CODES,
          ),
        ),
      ),
    /** 進捗（状態・進捗メモ・次にやること）を更新する。指定した項目だけを変える。 */
    updateProgress: base
      .input(
        z.object({
          id: z.string().min(1),
          status: z.enum(TASK_STATUSES).optional(),
          progressNote: z.string().max(20_000).optional(),
          nextAction: z.string().trim().max(500).optional(),
        }),
      )
      .handler(async ({ context, input }) =>
        toTaskDto(
          await unwrapForOrpc(
            context.tasks.updateProgress(input.id, {
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
        toTaskDto(
          await unwrapForOrpc(
            context.tasks.setAutoTerms(input.id, input.enabled),
            ERROR_CODES,
          ),
        ),
      ),
    /** タスクを消す。所属していた会話は消さず、未所属に戻る。 */
    delete: base
      .input(z.object({ id: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(context.tasks.deleteTask(input.id), ERROR_CODES);
        return { id: input.id };
      }),
  },
  links: {
    /** タスクの関連リンク（登録した順）。 */
    list: base
      .input(z.object({ taskId: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        (
          await unwrapForOrpc(
            Result.pipe(
              requireTask(context, input.taskId),
              Result.andThen(() => context.tasks.listLinks(input.taskId)),
            ),
            ERROR_CODES,
          )
        ).map(toTaskLinkDto),
      ),
    create: base
      .input(taskLinkInput.extend({ taskId: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        toTaskLinkDto(
          await unwrapForOrpc(
            Result.pipe(
              requireTask(context, input.taskId),
              Result.andThen(() =>
                context.tasks.createLink({
                  taskId: input.taskId,
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
      .input(taskLinkInput.extend({ id: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        toTaskLinkDto(
          await unwrapForOrpc(
            context.tasks.updateLink(input.id, {
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
        await unwrapForOrpc(context.tasks.deleteLink(input.id), ERROR_CODES);
        return { id: input.id };
      }),
  },
  wikis: {
    /** Wiki（作った順）と、参照しているタスクの数。 */
    list: base.handler(async ({ context }) =>
      (await unwrapForOrpc(context.tasks.listWikis(), ERROR_CODES)).map(
        (wiki): WikiDto => ({
          id: wiki.id,
          name: wiki.name,
          taskCount: wiki.taskCount,
        }),
      ),
    ),
    /** Wiki の名前を変える（共有しているタスクすべてに反映される）。 */
    rename: base
      .input(z.object({ id: z.string().min(1), name: taskName }))
      .handler(async ({ context, input }) => {
        const wiki = await unwrapForOrpc(
          context.tasks.renameWiki(input.id, input.name),
          ERROR_CODES,
        );
        return { id: wiki.id, name: wiki.name };
      }),
  },
  wiki: {
    /** 削除済みのページからも保存済みの会話を読み込める。 */
    chat: base.input(wikiChatTarget).handler(async ({ context, input }) => {
      const row = await unwrapForOrpc(
        context.chats.getWikiChat(input.taskId, input.pageId),
        ERROR_CODES,
      );
      if (row === undefined) return null;
      const { chat, messages } = await unwrapForOrpc(
        context.chats.getChat(row.id),
        ERROR_CODES,
      );
      return { chat: toChatDto(chat), messages: messages.map(toMessageDto) };
    }),
    /** 初回送信で会話を作る。応答は通常どおり chat.reconnect で受け取る。 */
    ask: base
      .input(wikiChatTarget.extend({ message: userMessage, ...sendSettings }))
      .handler(async ({ context, input }) => {
        const runner = await unwrapForOrpc(
          Result.pipe(
            cwdForTask(context, input.taskId),
            Result.andThen((cwd) =>
              context.chatService.sendToWikiPage({
                ...input,
                cwd,
                message: input.message as Parameters<
                  ChatService["send"]
                >[0]["message"],
              }),
            ),
          ),
          ERROR_CODES,
        );
        return { chatId: runner.chatId };
      }),
    /** タスクが参照する Wiki のページ（タイトル順）。 */
    list: base
      .input(z.object({ taskId: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        (
          await unwrapForOrpc(
            Result.pipe(
              context.tasks.getTask(input.taskId),
              Result.andThen((task) => context.wiki.listPages(wikiIdOf(task))),
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
      .input(wikiPageInput.extend({ taskId: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        toWikiPageDto(
          await unwrapForOrpc(
            Result.pipe(
              context.tasks.getTask(input.taskId),
              Result.andThen((task) =>
                context.wiki.createPage({
                  wikiId: wikiIdOf(task),
                  title: input.title,
                  aliases: input.aliases,
                  body: input.body,
                }),
              ),
            ),
            ERROR_CODES,
          ),
        ),
      ),
    /**
     * 回答の中で選んだ語句のページを Claude に書かせて保存する。
     * 同じ名前のページがすでにあれば作らずに返す（created: false）。
     */
    generate: base
      .input(
        z.object({
          chatId: z.string().min(1),
          messageId: z.string().min(1),
          term: z.string().trim().min(1).max(MAX_PAGE_TERM_LENGTH),
        }),
      )
      .handler(async ({ context, input }) => {
        const { page, created } = await unwrapForOrpc(
          context.generateWikiPage(input),
          ERROR_CODES,
        );
        return { page: toWikiPageDto(page), created };
      }),
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
    /** 会話の回答の要約（メッセージ id → 要約）。回答のあとに作られるので取り直して使う。 */
    summaries: base
      .input(chatId)
      .handler(async ({ context, input }) =>
        unwrapForOrpc(
          context.chats.listMessageSummaries(input.id),
          ERROR_CODES,
        ),
      ),
    create: base
      .input(
        z.object({
          taskId: z.string().min(1).nullable().optional(),
          model: z.string().min(1).optional(),
          effort: z.string().min(1).nullable().optional(),
        }),
      )
      .handler(async ({ context, input }) =>
        toChatDto(
          await unwrapForOrpc(
            Result.pipe(
              requireTask(context, input.taskId),
              Result.andThen(() => cwdForTask(context, input.taskId)),
              Result.andThen((cwd) =>
                context.chats.createChat({
                  cwd,
                  taskId: input.taskId ?? null,
                  model: input.model,
                  effort: input.effort,
                }),
              ),
            ),
            ERROR_CODES,
          ),
        ),
      ),
    /** 会話の所属タスクを変える（null で未所属に戻す）。過去のメッセージとセッションはそのまま。 */
    setTask: base
      .input(chatId.extend({ taskId: z.string().min(1).nullable() }))
      .handler(async ({ context, input }) =>
        toChatDto(
          await unwrapForOrpc(
            Result.pipe(
              requireTask(context, input.taskId),
              Result.andThen(() => context.chats.getChat(input.id)),
              // 分岐元と分岐先は同じタスクに属する（会話ごと移す）
              Result.andThen(({ chat }) =>
                chat.wikiPageId !== null && chat.taskId !== input.taskId
                  ? Result.fail(new WikiChatTaskError())
                  : Result.pipe(
                      context.chats.setGroupTask(chat.groupId, input.taskId),
                      Result.andThen(() => context.chats.getChat(input.id)),
                    ),
              ),
              Result.map(({ chat }) => chat),
            ),
            ERROR_CODES,
          ),
        ),
      ),
    /** 会話の名前を変える（すべての分岐で共有する）。 */
    rename: base
      .input(chatId.extend({ title: z.string().trim().min(1).max(200) }))
      .handler(async ({ context, input }) =>
        toChatDto(
          await unwrapForOrpc(
            Result.pipe(
              context.chats.getChat(input.id),
              Result.andThen(({ chat }) =>
                context.chats.setGroupTitle(chat.groupId, input.title),
              ),
              Result.andThen(() => context.chats.getChat(input.id)),
              Result.map(({ chat }) => chat),
            ),
            ERROR_CODES,
          ),
        ),
      ),
    /** 会話をすべての分岐ごと消す。生成中の分岐は止めてから消す。 */
    delete: base.input(chatId).handler(async ({ context, input }) => {
      const { chat } = await unwrapForOrpc(
        context.chats.getChat(input.id),
        ERROR_CODES,
      );
      const branches = await unwrapForOrpc(
        context.chats.listGroup(chat.groupId),
        ERROR_CODES,
      );
      for (const branch of branches) {
        context.chatService.stop(branch.id);
      }
      await unwrapForOrpc(context.chats.deleteGroup(chat.groupId), ERROR_CODES);
      return { id: input.id };
    }),
    /** この分岐を開いたことを記録する（会話を開き直したときにこの分岐を表示する）。 */
    select: base.input(chatId).handler(async ({ context, input }) => {
      await unwrapForOrpc(context.chats.getChat(input.id), ERROR_CODES);
      await unwrapForOrpc(context.chats.markSelected(input.id), ERROR_CODES);
      return { id: input.id };
    }),
  },
  limits: {
    /** 最後に観測したサブスクリプションの利用枠（#116）。まだ無ければ null。 */
    get: base.handler(async ({ context }) =>
      unwrapForOrpc(context.rateLimits.latest(), ERROR_CODES),
    ),
  },
  search: {
    /** 会話タイトルと発言の本文を部分一致で探す（#115）。 */
    query: base
      .input(z.object({ q: z.string().trim().min(1).max(200) }))
      .handler(async ({ context, input }) =>
        unwrapForOrpc(context.search.search(input.q), ERROR_CODES),
      ),
  },
  queue: {
    /** 分岐の予約（送る順）と、送信を止めているか。 */
    list: base
      .input(z.object({ chatId: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        const { chat } = await unwrapForOrpc(
          context.chats.getChat(input.chatId),
          ERROR_CODES,
        );
        const items = await unwrapForOrpc(
          context.queue.list(input.chatId),
          ERROR_CODES,
        );
        const paused = await unwrapForOrpc(
          context.queue.isPaused(input.chatId),
          ERROR_CODES,
        );
        return {
          paused,
          /** サーバで生成中か（予約が送られて始まった生成を画面に映すため）。 */
          active:
            chat.status === "running" || chat.status === "awaiting_approval",
          items: items.map((item) => ({
            id: item.id,
            parts: item.parts,
            status: item.status,
          })),
        };
      }),
    /**
     * 生成中の分岐にメッセージを予約する。今の回答が終わってから、予約した順に送る。
     * 生成中でなければすぐ送る（一時停止中なら再開を待つ）。
     */
    add: base
      .input(z.object({ chatId: z.string().min(1), message: userMessage }))
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(context.chats.getChat(input.chatId), ERROR_CODES);
        const item = await unwrapForOrpc(
          context.queue.add({
            id: input.message.id,
            chatId: input.chatId,
            parts: input.message.parts,
          }),
          ERROR_CODES,
        );
        context.queueDispatcher.dispatch(input.chatId);
        return { id: item.id };
      }),
    /** 送る前の予約の本文を書き換える（画像や引用はそのまま）。 */
    update: base
      .input(
        z.object({ id: z.string().min(1), text: z.string().trim().min(1) }),
      )
      .handler(async ({ context, input }) => {
        const item = await unwrapForOrpc(
          context.queue.get(input.id),
          ERROR_CODES,
        );
        const parts = [
          ...(item.parts as { type: string }[]).filter(
            (part) => part.type !== "text",
          ),
          { type: "text", text: input.text },
        ];
        await unwrapForOrpc(
          context.queue.updateParts(input.id, parts),
          ERROR_CODES,
        );
        return { id: input.id };
      }),
    /** 予約を取り消す。 */
    remove: base
      .input(z.object({ id: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(context.queue.remove(input.id), ERROR_CODES);
        return { id: input.id };
      }),
    /** 保留（送信済みか分からない）の予約を、送信待ちに戻す。 */
    release: base
      .input(z.object({ id: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(context.queue.get(input.id), ERROR_CODES);
        await unwrapForOrpc(
          context.queue.setStatus(input.id, "pending"),
          ERROR_CODES,
        );
        return { id: input.id };
      }),
    /** 一時停止を解いて、残りの予約を送り始める。 */
    resume: base
      .input(z.object({ chatId: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(context.chats.getChat(input.chatId), ERROR_CODES);
        context.queueDispatcher.resume(input.chatId);
        return { chatId: input.chatId };
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
          ...sendSettings,
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
    /**
     * 完了した応答から分岐を作り、最初の発話の生成を始める（#76）。
     * 生成の続きは、新しい分岐の id で chat.reconnect から受け取る。
     */
    branch: base
      .input(
        z.object({
          parentId: z.string().min(1),
          messageId: z.string().min(1),
          branchId: z.string().uuid(),
          message: userMessage,
          selectBranch: z.boolean().default(true),
          ...sendSettings,
        }),
      )
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(
          context.chatService.branch({
            parentId: input.parentId,
            messageId: input.messageId,
            branchId: input.branchId,
            selectBranch: input.selectBranch,
            message: input.message as Parameters<
              ChatService["send"]
            >[0]["message"],
            model: input.model,
            effort: input.effort,
          }),
          ERROR_CODES,
        );
        return { chatId: input.branchId };
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
