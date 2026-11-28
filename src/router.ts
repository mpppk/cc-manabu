import { eventIterator, os } from "@orpc/server";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import type { InferUIMessageChunk } from "ai";
import * as z from "zod";
import { AGENT_LABELS, type AgentStatusHolder } from "./agents/status.ts";
import type { ApprovalBroker } from "./chat/approval-broker.ts";
import { checkImagePart, MAX_IMAGES_PER_MESSAGE } from "./chat/attachments.ts";
import type { ChatService, ChatUIMessage } from "./chat/chat-service.ts";
import type { QueueDispatcher } from "./chat/queue-dispatcher.ts";
import type { SessionSync } from "./chat/session-sync.ts";
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
import type { PreferencesRepository } from "./db/preferences-repository.ts";
import type { QueueRepository } from "./db/queue-repository.ts";
import type { RateLimitRepository } from "./db/rate-limit-repository.ts";
import {
  AGENT_IDS,
  type AgentId,
  type ChatRow,
  type GoalRunRow,
  type MessageRow,
  type TaskLinkRow,
  type TaskRow,
  type WikiCheckpointRow,
  type WikiPageRow,
  type WikiPageVersionRow,
} from "./db/schema.ts";
import type { SearchRepository } from "./db/search-repository.ts";
import {
  requireWikiId,
  type TaskNotFoundError,
  type TaskRepository,
  wikiIdOf,
} from "./db/task-repository.ts";
import {
  type WikiBatch,
  WikiCheckpointNotFoundError,
  type WikiHistoryRepository,
  WikiVersionNotFoundError,
} from "./db/wiki-history-repository.ts";
import type { WikiRepository } from "./db/wiki-repository.ts";
import { normalizeDirectories } from "./environment/directories.ts";
import type { DirectoryPicker } from "./environment/directory-picker.ts";
import { type OrpcErrorCodeMap, unwrapForOrpc } from "./errors/index.ts";
import type { GoalRuns } from "./task/goal-runs.ts";
import { taskLinkInput, taskName, taskProgressFields } from "./task/inputs.ts";
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
  preferences: PreferencesRepository;
  /** Wiki の変更履歴・元に戻す・チェックポイント（#166）。 */
  wikiHistory: WikiHistoryRepository;
  wiki: WikiRepository;
  chatService: ChatService;
  approvals: ApprovalBroker;
  claude: ClaudeStatusHolder;
  /** Claude Code 以外の AI（Codex・GitHub Copilot）の状態（#265）。 */
  agents: AgentStatusHolder;
  /** 回答や Wiki ページの中の語句から Wiki のページを Claude に書かせる。 */
  generateWikiPage: WikiPageGenerator;
  /**
   * 起動時のカレントディレクトリ。タスクに属さない会話の作業ディレクトリと、
   * 環境を選ばずに作ったタスクの環境のディレクトリに使う。
   */
  cwd: string;
  /** OS のフォルダを選ぶダイアログを開く。 */
  pickDirectory: DirectoryPicker;
  /** タスクのゴールの実行（#198）。 */
  goalRuns: GoalRuns;
  /** Claude Code のセッションとの照合と、Claude Desktop で開く操作（#244）。 */
  sessionSync: SessionSync;
};

export const base = os.$context<RouterContext>();

/** 選んだ AI が使えないとき（#265）。理由と設定の手順を伝える。 */
export class AgentUnavailableError extends ErrorFactory({
  name: "AgentUnavailableError",
  message: (fields) => fields.detail,
  fields: ErrorFactory.fields<{ detail: string }>(),
}) {}

/** Claude Code 以外の AI なら、使える状態かを確かめる。 */
const requireAgent = (
  context: RouterContext,
  agent: AgentId | undefined,
): Result.Result<void, AgentUnavailableError> => {
  if (agent === undefined || agent === "claude-code") return Result.succeed();
  const status = context.agents.get()[agent];
  if (status.state === "ready") return Result.succeed();
  const label = AGENT_LABELS[agent];
  return Result.fail(
    new AgentUnavailableError({
      detail:
        status.state === "checking"
          ? `${label} の状態を確かめています。しばらくしてからもう一度お試しください。`
          : [status.reason, ...status.setup.map((step) => `- ${step}`)].join(
              "\n",
            ),
    }),
  );
};

const ERROR_CODES: OrpcErrorCodeMap = {
  AgentUnavailableError: "BAD_REQUEST",
  ChatNotFoundError: "NOT_FOUND",
  TaskNotFoundError: "NOT_FOUND",
  EnvironmentNotFoundError: "NOT_FOUND",
  EnvironmentNotEmptyError: "CONFLICT",
  WikiNotFoundError: "NOT_FOUND",
  TaskWithoutWikiError: "BAD_REQUEST",
  DirectoryNotFoundError: "BAD_REQUEST",
  RelativeDirectoryError: "BAD_REQUEST",
  DirectoryPickerUnavailableError: "SERVICE_UNAVAILABLE",
  DirectoryPickerError: "INTERNAL_SERVER_ERROR",
  TaskLinkNotFoundError: "NOT_FOUND",
  GoalNotSetError: "BAD_REQUEST",
  GoalRunAlreadyActiveError: "CONFLICT",
  GoalRunNotActiveError: "CONFLICT",
  QueuedMessageNotFoundError: "NOT_FOUND",
  WikiPageNotFoundError: "NOT_FOUND",
  WikiPageUnavailableError: "NOT_FOUND",
  WikiChatTaskError: "BAD_REQUEST",
  ChatWithoutTaskError: "BAD_REQUEST",
  AnswerNotFoundError: "NOT_FOUND",
  WikiPageQaNotFoundError: "NOT_FOUND",
  InvalidPageTermError: "BAD_REQUEST",
  ChatAlreadyRunningError: "CONFLICT",
  ChatSessionMissingError: "CONFLICT",
  ChatBusyError: "CONFLICT",
  DesktopLaunchError: "SERVICE_UNAVAILABLE",
  TooManyRunnersError: "TOO_MANY_REQUESTS",
  ApprovalNotFoundError: "NOT_FOUND",
  MessageNotFoundError: "NOT_FOUND",
  NothingToRegenerateError: "BAD_REQUEST",
  NotBranchableError: "BAD_REQUEST",
  UnsupportedForAgentError: "BAD_REQUEST",
  WikiVersionNotFoundError: "NOT_FOUND",
  WikiCheckpointNotFoundError: "NOT_FOUND",
  NothingToUndoError: "BAD_REQUEST",
  WikiHistoryConflictError: "CONFLICT",
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
  | "archivedAt"
  | "taskId"
  | "wikiPageId"
  | "title"
  | "agent"
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
  archivedAt: row.archivedAt,
  taskId: row.taskId,
  wikiPageId: row.wikiPageId,
  title: row.title,
  agent: row.agent,
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
  | "archivedAt"
  | "createdAt"
> & {
  /** 所属する環境。 */
  environmentId: string | null;
  /** 参照する Wiki（所属する環境の Wiki）。環境が Wiki を使っていなければ null（#232）。 */
  wikiId: string | null;
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
  archivedAt: row.archivedAt,
  createdAt: row.createdAt,
});

/** クライアントに返す環境。 */
export type EnvironmentDto = Pick<
  EnvironmentSummary,
  | "id"
  | "name"
  | "wikiId"
  | "wikiName"
  | "directories"
  | "description"
  | "taskCount"
>;

const toEnvironmentDto = (row: EnvironmentSummary): EnvironmentDto => ({
  id: row.id,
  name: row.name,
  wikiId: row.wikiId,
  wikiName: row.wikiName,
  directories: row.directories,
  description: row.description,
  taskCount: row.taskCount,
});

/** 環境の入力。ディレクトリは 1 つ以上（先頭が作業ディレクトリ）。 */
const environmentName = z.string().trim().min(1).max(100);
const directoriesInput = z
  .array(z.string().trim().min(1).max(4096))
  .min(1)
  .max(20);
/** 環境の目的や扱うテーマ（任意。空欄でもよい）。 */
const environmentDescription = z.string().trim().max(2000);

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

/** クライアントに返すゴールの実行（#198）。 */
export type GoalRunDto = Pick<
  GoalRunRow,
  "id" | "taskId" | "chatId" | "goal" | "state" | "reason"
> & { createdAt: string; updatedAt: string };

const toGoalRunDto = (row: GoalRunRow): GoalRunDto => ({
  id: row.id,
  taskId: row.taskId,
  chatId: row.chatId,
  goal: row.goal,
  state: row.state,
  reason: row.reason,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

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

/** 版（#166）。本文は含めない（一覧に使う）。 */
const toWikiVersionDto = (row: WikiPageVersionRow) => ({
  seq: row.seq,
  pageId: row.pageId,
  title: row.title,
  deleted: row.deleted,
  op: row.op,
  actor: row.actor,
  tool: row.tool,
  chatId: row.chatId,
  messageId: row.messageId,
  restoredFrom: row.restoredFrom,
  createdAt: row.createdAt,
});
export type WikiVersionDto = ReturnType<typeof toWikiVersionDto>;

const toWikiBatchDto = (batch: WikiBatch) => ({
  batchId: batch.batchId,
  op: batch.op,
  actor: batch.actor,
  pages: batch.pages,
  createdAt: batch.createdAt,
});
export type WikiBatchDto = ReturnType<typeof toWikiBatchDto>;

const toCheckpointDto = (row: WikiCheckpointRow) => ({
  id: row.id,
  name: row.name,
  auto: row.auto,
  chatId: row.chatId,
  createdAt: row.createdAt,
});
export type WikiCheckpointDto = ReturnType<typeof toCheckpointDto>;

/** タスクが参照する Wiki の ID。環境が Wiki を使っていなければ TaskWithoutWikiError。 */
const wikiOfTask = (context: RouterContext, taskId: string) =>
  Result.pipe(context.tasks.getTask(taskId), Result.andThen(requireWikiId));

/** 版・チェックポイントが、タスクの Wiki のものか確かめる（ほかの Wiki のものは見つからない扱い）。 */
const inWiki = <T extends { wikiId: string }>(
  context: RouterContext,
  taskId: string,
  row: T,
  notFound: () => Error,
) =>
  Result.pipe(
    wikiOfTask(context, taskId),
    Result.andThen((wikiId) =>
      row.wikiId === wikiId ? Result.succeed(row) : Result.fail(notFound()),
    ),
  );

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
          sourcePage?: { id?: unknown; title?: unknown };
          range?: { start?: unknown; end?: unknown };
        };
        // 回答の中の位置（#239）は任意。あれば 0 以上の整数で start < end
        const validRange =
          data?.range === undefined ||
          (Number.isInteger(data.range?.start) &&
            Number.isInteger(data.range?.end) &&
            (data.range.start as number) >= 0 &&
            (data.range.start as number) < (data.range.end as number));
        // 回答からの引用は sourceMessageId、Wiki ページからの引用は sourcePage を持つ
        const hasSource =
          typeof data?.sourceMessageId === "string" ||
          (typeof data?.sourcePage?.id === "string" &&
            typeof data.sourcePage.title === "string" &&
            data.sourcePage.title.length <= 200);
        if (
          typeof data?.text !== "string" ||
          data.text.trim() === "" ||
          data.text.length > 20_000 ||
          !hasSource ||
          !validRange
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
      agents: context.agents.get(),
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
    /**
     * 環境を作る。wikiId を渡すとその Wiki を共有し、null なら Wiki を使わず（#232）、
     * 無ければ同じ名前の Wiki を新しく作る。
     */
    create: base
      .input(
        z.object({
          name: environmentName,
          directories: directoriesInput,
          description: environmentDescription.optional(),
          /** null なら Wiki を使わない（#232）。 */
          wikiId: z.string().min(1).nullable().optional(),
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
                ...(input.description === undefined
                  ? {}
                  : { description: input.description }),
                ...(input.wikiId === undefined ? {} : { wikiId: input.wikiId }),
              }),
            ),
            Result.andThen((row) => environmentDto(context, row.id)),
          ),
          ERROR_CODES,
        ),
      ),
    /**
     * 名前・ディレクトリ・説明・参照する Wiki を変える（指定した項目だけ）。
     * ディレクトリの先頭を変えても、作業ディレクトリは新しいスレッドからしか変わらない。
     */
    update: base
      .input(
        z.object({
          id: z.string().min(1),
          name: environmentName.optional(),
          directories: directoriesInput.optional(),
          description: environmentDescription.optional(),
          /** null なら Wiki を使わなくする（#232）。 */
          wikiId: z.string().min(1).nullable().optional(),
          /** 環境と同じ名前の Wiki を新しく作って使う。wikiId と同時には指定しない。 */
          newWiki: z.boolean().optional(),
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
                ...(input.description === undefined
                  ? {}
                  : { description: input.description }),
                ...(input.wikiId === undefined ? {} : { wikiId: input.wikiId }),
                ...(input.newWiki === true ? { newWiki: true } : {}),
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
    /** 進捗（状態・進捗メモ・ゴール）を更新する。指定した項目だけを変える。 */
    updateProgress: base
      .input(
        z.object({
          id: z.string().min(1),
          ...taskProgressFields,
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
    /** タスクの最新のゴールの実行（#198）。無ければ null。 */
    goalRun: base
      .input(z.object({ id: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        const run = await unwrapForOrpc(
          Result.pipe(
            requireTask(context, input.id),
            Result.andThen(() => context.goalRuns.latest(input.id)),
          ),
          ERROR_CODES,
        );
        return run === undefined ? null : toGoalRunDto(run);
      }),
    /** 保存済みのゴールで実行を始める。作ったスレッドを返す（#198）。 */
    runGoal: base
      .input(z.object({ id: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        const started = await unwrapForOrpc(
          context.goalRuns.start(input.id),
          ERROR_CODES,
        );
        return { chatId: started.chatId, run: toGoalRunDto(started.run) };
      }),
    /** 進行中のゴールの実行を止める（#198）。 */
    stopGoal: base
      .input(z.object({ id: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        toGoalRunDto(
          await unwrapForOrpc(context.goalRuns.stop(input.id), ERROR_CODES),
        ),
      ),
    /**
     * タスクをアーカイブする・復元する（#241）。進捗の状態・環境・スレッドの所属はそのまま。
     * アーカイブしたタスクは通常の一覧から隠れるが、直接のリンクからは開ける。
     */
    setArchived: base
      .input(z.object({ id: z.string().min(1), archived: z.boolean() }))
      .handler(async ({ context, input }) =>
        toTaskDto(
          await unwrapForOrpc(
            context.tasks.setArchived(input.id, input.archived),
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
    /**
     * このタスクでページについて質問した回答から作った Q&A（作った順。#159）。
     * Wiki を共有していても、ほかのタスクの Q&A は返さない。
     */
    qas: base.input(wikiChatTarget).handler(async ({ context, input }) =>
      (
        await unwrapForOrpc(
          context.wiki.listQas(input.taskId, input.pageId),
          ERROR_CODES,
        )
      ).map((row) => ({
        id: row.id,
        chatId: row.chatId,
        messageId: row.messageId,
        question: row.question,
        answer: row.answer,
        createdAt: row.createdAt,
      })),
    ),
    /** 初回送信で会話を作る。回答は通常どおり chat.reconnect で受け取る。 */
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
    /** ページの版（新しい順。#166）。 */
    history: base.input(wikiChatTarget).handler(async ({ context, input }) => {
      const wikiId = await unwrapForOrpc(
        wikiOfTask(context, input.taskId),
        ERROR_CODES,
      );
      return (
        await unwrapForOrpc(
          context.wikiHistory.listPageVersions(input.pageId),
          ERROR_CODES,
        )
      )
        .filter((row) => row.wikiId === wikiId)
        .map(toWikiVersionDto);
    }),
    /** 版の中身（差分の表示に使う）。 */
    version: base
      .input(z.object({ taskId: z.string().min(1), seq: z.number().int() }))
      .handler(async ({ context, input }) => {
        const row = await unwrapForOrpc(
          Result.pipe(
            context.wikiHistory.getVersion(input.seq),
            Result.andThen((row) =>
              inWiki(
                context,
                input.taskId,
                row,
                () => new WikiVersionNotFoundError(),
              ),
            ),
          ),
          ERROR_CODES,
        );
        return {
          ...toWikiVersionDto(row),
          aliases: row.aliases,
          body: row.body,
        };
      }),
    /** 版の内容でページを復元する（削除したページも戻す）。 */
    restoreVersion: base
      .input(z.object({ taskId: z.string().min(1), seq: z.number().int() }))
      .handler(async ({ context, input }) => {
        const row = await unwrapForOrpc(
          Result.pipe(
            context.wikiHistory.getVersion(input.seq),
            Result.andThen((row) =>
              inWiki(
                context,
                input.taskId,
                row,
                () => new WikiVersionNotFoundError(),
              ),
            ),
            Result.andThen(() => context.wikiHistory.restoreVersion(input.seq)),
          ),
          ERROR_CODES,
        );
        return { pageId: row.pageId };
      }),
    /** 削除したページ（新しく消した順）。 */
    deletedPages: base
      .input(z.object({ taskId: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        (
          await unwrapForOrpc(
            Result.pipe(
              wikiOfTask(context, input.taskId),
              Result.andThen((wikiId) =>
                context.wikiHistory.listDeletedPages(wikiId),
              ),
            ),
            ERROR_CODES,
          )
        ).map(toWikiVersionDto),
      ),
    /** 元に戻せる・やり直せる変更。 */
    undoState: base
      .input(z.object({ taskId: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        const state = await unwrapForOrpc(
          Result.pipe(
            wikiOfTask(context, input.taskId),
            Result.andThen((wikiId) => context.wikiHistory.undoState(wikiId)),
          ),
          ERROR_CODES,
        );
        return {
          undo: state.undo === undefined ? null : toWikiBatchDto(state.undo),
          redo: state.redo === undefined ? null : toWikiBatchDto(state.redo),
        };
      }),
    /** 直前の変更を元に戻す（redo なら、戻した変更をやり直す）。 */
    undo: base
      .input(
        z.object({
          taskId: z.string().min(1),
          redo: z.boolean().default(false),
        }),
      )
      .handler(async ({ context, input }) =>
        toWikiBatchDto(
          await unwrapForOrpc(
            Result.pipe(
              wikiOfTask(context, input.taskId),
              Result.andThen((wikiId) =>
                context.wikiHistory.undo(wikiId, input.redo),
              ),
            ),
            ERROR_CODES,
          ),
        ),
      ),
    /** 回答で Claude が Wiki に加えた変更と、元に戻したか（無ければ null）。 */
    answerChanges: base
      .input(z.object({ messageId: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        const changes = await unwrapForOrpc(
          context.wikiHistory.answerChanges(input.messageId),
          ERROR_CODES,
        );
        return changes === undefined
          ? null
          : { batch: toWikiBatchDto(changes.batch), undone: changes.undone };
      }),
    /** 回答で Claude が Wiki に加えた変更をまとめて元に戻す（redo ならやり直す）。 */
    undoAnswer: base
      .input(
        z.object({
          messageId: z.string().min(1),
          redo: z.boolean().default(false),
        }),
      )
      .handler(async ({ context, input }) =>
        toWikiBatchDto(
          await unwrapForOrpc(
            context.wikiHistory.undoAnswer(input.messageId, input.redo),
            ERROR_CODES,
          ),
        ),
      ),
    /** チェックポイント（新しい順）。 */
    checkpoints: base
      .input(z.object({ taskId: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        (
          await unwrapForOrpc(
            Result.pipe(
              wikiOfTask(context, input.taskId),
              Result.andThen((wikiId) =>
                context.wikiHistory.listCheckpoints(wikiId),
              ),
            ),
            ERROR_CODES,
          )
        ).map(toCheckpointDto),
      ),
    /** 今の Wiki 全体の状態に名前を付けて残す。 */
    createCheckpoint: base
      .input(
        z.object({
          taskId: z.string().min(1),
          name: z.string().trim().min(1).max(100),
        }),
      )
      .handler(async ({ context, input }) =>
        toCheckpointDto(
          await unwrapForOrpc(
            Result.pipe(
              wikiOfTask(context, input.taskId),
              Result.andThen((wikiId) =>
                context.wikiHistory.createCheckpoint({
                  wikiId,
                  name: input.name,
                }),
              ),
            ),
            ERROR_CODES,
          ),
        ),
      ),
    /** Wiki 全体をチェックポイントの時点に戻す。変えたページの数を返す。 */
    restoreCheckpoint: base
      .input(z.object({ taskId: z.string().min(1), id: z.string().min(1) }))
      .handler(async ({ context, input }) => {
        const checkpoints = await unwrapForOrpc(
          Result.pipe(
            wikiOfTask(context, input.taskId),
            Result.andThen((wikiId) =>
              context.wikiHistory.listCheckpoints(wikiId),
            ),
          ),
          ERROR_CODES,
        );
        if (!checkpoints.some((checkpoint) => checkpoint.id === input.id)) {
          await unwrapForOrpc(
            Result.fail(new WikiCheckpointNotFoundError()),
            ERROR_CODES,
          );
        }
        return {
          changed: await unwrapForOrpc(
            context.wikiHistory.restoreCheckpoint(input.id),
            ERROR_CODES,
          ),
        };
      }),
    /** タスクが参照する Wiki のページ（タイトル順）。 */
    list: base
      .input(z.object({ taskId: z.string().min(1) }))
      .handler(async ({ context, input }) =>
        (
          await unwrapForOrpc(
            Result.pipe(
              context.tasks.getTask(input.taskId),
              // Wiki を使わない環境のタスクには、ページが無いものとして返す（#232）
              Result.andThen((task) => {
                const wikiId = wikiIdOf(task);
                return wikiId === null
                  ? Result.succeed([])
                  : context.wiki.listPages(wikiId);
              }),
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
              wikiOfTask(context, input.taskId),
              Result.andThen((wikiId) =>
                context.wiki.createPage({
                  wikiId,
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
    /**
     * Wiki ページの本文で選んだ語句のページを Claude に書かせて保存する。
     * 同じ名前のページがすでにあれば作らずに返す（created: false）。
     */
    generateFromPage: base
      .input(
        wikiChatTarget.extend({
          term: z.string().trim().min(1).max(MAX_PAGE_TERM_LENGTH),
          /** ページの Q&A の中で選んだときの Q&A（#205）。その Q&A を資料にする。 */
          qaId: z.string().min(1).optional(),
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
    /** 会話の中の分岐点と、そこから分岐した同じスレッドの会話（#235）。 */
    forkPoints: base
      .input(chatId)
      .handler(async ({ context, input }) =>
        unwrapForOrpc(context.chats.listForkPoints(input.id), ERROR_CODES),
      ),
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
          /** 会話に使う AI（#265）。省くと Claude Code。 */
          agent: z.enum(AGENT_IDS).optional(),
          model: z.string().min(1).optional(),
          effort: z.string().min(1).nullable().optional(),
        }),
      )
      .handler(async ({ context, input }) =>
        toChatDto(
          await unwrapForOrpc(
            Result.pipe(
              requireAgent(context, input.agent),
              Result.andThen(() => requireTask(context, input.taskId)),
              Result.andThen(() => cwdForTask(context, input.taskId)),
              Result.andThen((cwd) =>
                context.chats.createChat({
                  cwd,
                  taskId: input.taskId ?? null,
                  model: input.model,
                  effort: input.effort,
                  ...(input.agent === undefined ? {} : { agent: input.agent }),
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
              // 分岐元と分岐先は同じタスクに属する（スレッドごと移す）
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
    /** スレッドの名前を変える（すべての会話で共有する）。 */
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
    /** スレッドをすべての会話ごと消す。生成中の会話は止めてから消す。 */
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
    /** この会話を開いたことを記録する（スレッドを開き直したときにこの会話を表示する）。 */
    select: base.input(chatId).handler(async ({ context, input }) => {
      await unwrapForOrpc(context.chats.getChat(input.id), ERROR_CODES);
      await unwrapForOrpc(context.chats.markSelected(input.id), ERROR_CODES);
      return { id: input.id };
    }),
    /**
     * 会話の Claude Code セッションに、Monet の外（Claude Desktop・CLI）で足された質問があるか（#244）。
     * ローカルの履歴を読むだけで、Claude の生成もセッションへの書き込みもしない。
     */
    sessionSync: base
      .input(chatId)
      .handler(async ({ context, input }) =>
        unwrapForOrpc(context.sessionSync.check(input.id), ERROR_CODES),
      ),
    /**
     * 会話のスレッドをアーカイブする・復元する（#256）。元の会話と分岐を含むスレッド単位で変える。
     * 所属・履歴・分岐はそのまま。
     */
    setArchived: base
      .input(z.object({ id: z.string().min(1), archived: z.boolean() }))
      .handler(async ({ context, input }) => {
        const { chat } = await unwrapForOrpc(
          context.chats.getChat(input.id),
          ERROR_CODES,
        );
        await unwrapForOrpc(
          context.chats.setGroupArchived(
            chat.groupId === "" ? chat.id : chat.groupId,
            input.archived,
          ),
          ERROR_CODES,
        );
        return { id: input.id };
      }),
    /**
     * 会話の最後に取れたコンテキストの使用量（#245）。まだ取れていなければ null。
     * 読むだけで、Claude の生成は始めない。
     */
    contextUsage: base.input(chatId).handler(async ({ context, input }) => {
      const { chat } = await unwrapForOrpc(
        context.chats.getChat(input.id),
        ERROR_CODES,
      );
      return chat.contextUsage ?? null;
    }),
    /** 会話のセッションを、作業ディレクトリから Claude Desktop で開く（#244）。 */
    openInDesktop: base.input(chatId).handler(async ({ context, input }) => {
      await unwrapForOrpc(
        context.sessionSync.openInDesktop(input.id),
        ERROR_CODES,
      );
      return { id: input.id };
    }),
  },
  preferences: {
    /** 新規スレッドの初期値にする、最後に選んだモデルと effort（#164）。まだ無ければ null。 */
    chatDefaults: base.handler(async ({ context }) =>
      unwrapForOrpc(context.preferences.chatDefaults(), ERROR_CODES),
    ),
    /** モデルか effort を利用者が選び直したときに呼ぶ。 */
    setChatDefaults: base
      .input(
        z.object({
          model: sendSettings.model.unwrap(),
          effort: sendSettings.effort.unwrap(),
        }),
      )
      .handler(async ({ context, input }) => {
        await unwrapForOrpc(
          context.preferences.saveChatDefaults(input),
          ERROR_CODES,
        );
      }),
  },
  limits: {
    /** 最後に観測したサブスクリプションの利用枠（#116）。まだ無ければ null。 */
    get: base.handler(async ({ context }) =>
      unwrapForOrpc(context.rateLimits.latest(), ERROR_CODES),
    ),
  },
  search: {
    /** スレッドのタイトルと発言の本文を部分一致で探す（#115）。 */
    query: base
      .input(z.object({ q: z.string().trim().min(1).max(200) }))
      .handler(async ({ context, input }) =>
        unwrapForOrpc(context.search.search(input.q), ERROR_CODES),
      ),
  },
  queue: {
    /** 会話の予約（送る順）と、送信を止めているか。 */
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
     * 生成中の会話にメッセージを予約する。今の回答が終わってから、予約した順に送る。
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
     * 完了した回答から分岐して新しい会話を作り、最初の発話の生成を始める（#76）。
     * 生成の続きは、新しい会話の id で chat.reconnect から受け取る。
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
    /** 最後の回答を作り直す（直前のターンから fork する）。 */
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
