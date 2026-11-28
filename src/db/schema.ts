import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const CHAT_STATUSES = [
  "idle",
  "running",
  "awaiting_approval",
  "error",
] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];

/** タスクの進捗の状態（#104）。 */
export const TASK_STATUSES = [
  "not_started",
  "in_progress",
  /** ゴールの実行で、利用者の確認・判断・承認を待っている（#198）。 */
  "needs_review",
  "on_hold",
  "done",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Wiki（ページのまとまり）。複数のタスクで共有できる。
 * どのタスクからも参照されなくなったら、ページごと消す。
 */
export const wikis = sqliteTable("wikis", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
});

/**
 * 環境。Claude Code に渡すディレクトリと、参照する Wiki をまとめる。タスクは 1 つの環境に属する。
 * Wiki はほかの環境と共有でき、使わないこともできる（#232）。
 */
export const environments = sqliteTable("environments", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** 参照する Wiki。Wiki を使わない環境では null（#232）。 */
  wikiId: text("wiki_id").references(() => wikis.id),
  /**
   * Claude Code に渡すディレクトリ（絶対パスの JSON 配列）。
   * 先頭が新しいスレッドの作業ディレクトリ、残りは追加のディレクトリ（--add-dir）。
   */
  directories: text("directories", { mode: "json" })
    .notNull()
    .$type<string[]>()
    .default(sql`'[]'`),
  /**
   * 環境の目的や扱うテーマ（任意）。回答からの用語ページの自動作成で、
   * Wiki に残す価値のある語を選ぶのに使う（#160）。
   */
  description: text("description").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`),
});

/** 複数のスレッドをまとめる単位。1 つの環境に属する。 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /**
     * 所属する環境。既存の行に後から足した列なので DB では null を許すが、アプリは必ず設定する。
     */
    environmentId: text("environment_id").references(() => environments.id),
    /**
     * 参照する Wiki。所属する環境の Wiki の写しで、環境の Wiki を変えたとき・環境を移したときに
     * リポジトリが合わせる（列を外すには表の作り直しが要るので、写しとして残している）。
     * 環境が Wiki を使わなければ null（#232）。
     */
    wikiId: text("wiki_id").references(() => wikis.id),
    /** 回答から用語ページを自動で作るか（回答ごとに Claude を追加で呼び出す）。 */
    autoTerms: integer("auto_terms", { mode: "boolean" })
      .notNull()
      .default(true),
    /** 進捗の状態。既存のタスクは未着手として扱う。 */
    status: text("status", { enum: TASK_STATUSES })
      .notNull()
      .default("not_started"),
    /** 進捗メモ（任意）。 */
    progressNote: text("progress_note").notNull().default(""),
    /** ゴール（任意）。 */
    nextAction: text("next_action").notNull().default(""),
    /** 状態・進捗メモ・ゴールを最後に変えた日時。まだ変えていなければ null。 */
    progressUpdatedAt: integer("progress_updated_at", { mode: "timestamp_ms" }),
    /**
     * アーカイブした日時。アーカイブしていなければ null（#241）。
     * 進捗の状態とは別に持ち、復元すると元の状態のまま通常の一覧に戻る。
     */
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [index("tasks_environment_id_idx").on(table.environmentId)],
);

export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(),
    /** 所属するタスク。未所属なら null。タスクを消すと未所属に戻る。 */
    taskId: text("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    /** ページを削除した後も履歴を開けるよう、外部キーにはしない。 */
    wikiPageId: text("wiki_page_id"),
    title: text("title").notNull().default(""),
    /** resume する Claude Code のセッション ID。最初の送信まではない。 */
    sessionId: text("session_id"),
    model: text("model").notNull().default("default"),
    effort: text("effort"),
    cwd: text("cwd").notNull(),
    status: text("status", { enum: CHAT_STATUSES }).notNull().default("idle"),
    /**
     * スレッド（会話のまとまり）の ID（#76）。元の会話では自分の id。
     * サイドバーにはスレッドごとに 1 行を出し、タイトル・タスク・作業ディレクトリはスレッドで共有する。
     */
    groupId: text("group_id").notNull().default(""),
    /** 分岐元の会話。元の会話では null。 */
    parentId: text("parent_id"),
    /** 分岐元で分岐点にした assistant メッセージの id。 */
    forkMessageId: text("fork_message_id"),
    /** 分岐元から引き継いだメッセージの数（これより後ろがこの会話で書いたメッセージ）。 */
    inheritedCount: integer("inherited_count").notNull().default(0),
    /** 分岐した会話の名前（最初の発言から作る）。元の会話では空。 */
    branchTitle: text("branch_title").notNull().default(""),
    /**
     * 分岐した会話の最初の送信で resume する分岐元のセッションと、巻き戻す地点（assistant uuid）。
     * 送信して自分のセッション（sessionId）ができるまで使う。
     */
    forkSessionId: text("fork_session_id"),
    forkFromUuid: text("fork_from_uuid"),
    /** 最後にこの会話を開いた日時（スレッドを開き直したときに表示する会話）。 */
    lastSelectedAt: integer("last_selected_at", { mode: "timestamp_ms" }),
    /** 予約したメッセージの送信を止めているか（停止・エラーのあと。#102）。 */
    queuePaused: integer("queue_paused", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    index("chats_updated_at_idx").on(table.updatedAt),
    index("chats_task_id_idx").on(table.taskId),
    index("chats_group_id_idx").on(table.groupId),
    uniqueIndex("chats_task_wiki_page_idx")
      .on(table.taskId, table.wikiPageId)
      .where(
        sql`${table.parentId} IS NULL AND ${table.wikiPageId} IS NOT NULL`,
      ),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    /** UIMessage の id。 */
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    /** 会話内での順番（0 始まり）。 */
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    /** UIMessage の parts（JSON）。 */
    parts: text("parts", { mode: "json" }).notNull().$type<unknown[]>(),
    /** UIMessage の metadata（usage、costUsd など。JSON）。 */
    metadata: text("metadata", { mode: "json" }).$type<unknown>(),
    /**
     * assistant 行: そのターンで最後に届いた assistant メッセージの uuid。
     * 再生成・編集の分岐点に使う（docs/spikes/session-branching.md）。
     */
    sdkUuid: text("sdk_uuid"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [uniqueIndex("messages_chat_seq_idx").on(table.chatId, table.seq)],
);

/** Wiki のページ（Markdown）。Wiki を消すと一緒に消える。 */
export const wikiPages = sqliteTable(
  "wiki_pages",
  {
    /** 安定したページ ID（回答からのリンクに使う）。 */
    id: text("id").primaryKey(),
    wikiId: text("wiki_id")
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** 別名（JSON の文字列配列）。関連ページの照合とリンクに使う。 */
    aliases: text("aliases", { mode: "json" })
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),
    /** Markdown の本文。 */
    body: text("body").notNull().default(""),
    /** 作られ方。auto は回答からの自動作成（#80）。 */
    origin: text("origin", { enum: ["manual", "auto"] })
      .notNull()
      .default("manual"),
    /** 自動作成の元になった会話と回答。会話を消すと null になる。 */
    sourceChatId: text("source_chat_id").references(() => chats.id, {
      onDelete: "set null",
    }),
    sourceMessageId: text("source_message_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [index("wiki_pages_wiki_id_idx").on(table.wikiId)],
);

/** 版を作った操作（#166）。 */
export const WIKI_VERSION_OPS = [
  /** 履歴を記録する前からあったページ（マイグレーションで記録）。 */
  "baseline",
  /** ページの作成・更新・削除。 */
  "change",
  /** 元に戻す。reverts の変更をまとめて戻す。 */
  "undo",
  /** やり直す。reverts の変更をもう一度当てる。 */
  "redo",
  /** 過去の版・チェックポイントへの復元。 */
  "restore",
] as const;
export type WikiVersionOp = (typeof WIKI_VERSION_OPS)[number];

/** 変更の出どころ（#166）。 */
export const WIKI_VERSION_ACTORS = [
  /** 利用者（Wiki 画面の編集・復元・元に戻す）。 */
  "user",
  /** Claude（タスクのスレッドから wiki ツールで編集・作成）。 */
  "claude",
  /** 回答からの用語ノートの自動作成。 */
  "auto",
  /** 回答・ノートの選択範囲からのノート作成。 */
  "selection",
  /** 履歴を記録する前の状態。 */
  "system",
  /**
   * Claude Desktop（`monet mcp` の MCP ツールで編集・作成。#212）。
   * 列は text なので、値を足してもマイグレーションは要らない。
   */
  "claude_desktop",
] as const;
export type WikiVersionActor = (typeof WIKI_VERSION_ACTORS)[number];

/**
 * Wiki ページの版（#166）。作成・更新・削除のたびに、変更後の状態を 1 行追加する。
 * seq は Wiki をまたいで単調に増え、チェックポイントの時点の状態を求めるのに使う。
 * ページを消しても版は残す（削除したページも復元できる）。Wiki を消すと一緒に消える。
 */
export const wikiPageVersions = sqliteTable(
  "wiki_page_versions",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    wikiId: text("wiki_id")
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    pageId: text("page_id").notNull(),
    title: text("title").notNull(),
    aliases: text("aliases", { mode: "json" })
      .notNull()
      .$type<string[]>()
      .default(sql`'[]'`),
    body: text("body").notNull().default(""),
    /** この版でページが削除されたか（title などは削除直前の内容）。 */
    deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
    /** ページの属性（復元するときに戻す）。 */
    origin: text("origin", { enum: ["manual", "auto"] })
      .notNull()
      .default("manual"),
    sourceChatId: text("source_chat_id"),
    sourceMessageId: text("source_message_id"),
    op: text("op", { enum: WIKI_VERSION_OPS }).notNull(),
    actor: text("actor", { enum: WIKI_VERSION_ACTORS }).notNull(),
    /** 一緒に元に戻す変更のまとまり（1 回の保存・1 回の回答・1 回の復元）。 */
    batchId: text("batch_id").notNull(),
    /** undo / redo の対象のまとまり。 */
    reverts: text("reverts"),
    /** 変更した会話・回答・ツール（Claude の編集、回答からの作成）。会話を消しても残す。 */
    chatId: text("chat_id"),
    messageId: text("message_id"),
    tool: text("tool"),
    /** 復元の元（版の seq、またはチェックポイントの id）。 */
    restoredFrom: text("restored_from"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    index("wiki_page_versions_page_idx").on(table.pageId, table.seq),
    index("wiki_page_versions_wiki_idx").on(table.wikiId, table.seq),
    index("wiki_page_versions_batch_idx").on(table.batchId),
    index("wiki_page_versions_message_idx").on(table.messageId),
  ],
);

export type WikiPageVersionRow = typeof wikiPageVersions.$inferSelect;

/**
 * Wiki 全体のチェックポイント（#166）。seq までの版で、Wiki 全体の状態を表す。
 * 名前を付けて作るほか、Claude が Wiki を変更する回答の前に自動で作る。
 */
export const wikiCheckpoints = sqliteTable(
  "wiki_checkpoints",
  {
    id: text("id").primaryKey(),
    wikiId: text("wiki_id")
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** 自動で作ったか（Claude の変更の前）。 */
    auto: integer("auto", { mode: "boolean" }).notNull().default(false),
    /** この時点までの版（これより後の版は含まない）。 */
    seq: integer("seq").notNull(),
    /** 自動で作ったときの会話と、その回答の変更のまとまり。 */
    chatId: text("chat_id"),
    batchId: text("batch_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [index("wiki_checkpoints_wiki_idx").on(table.wikiId)],
);

export type WikiCheckpointRow = typeof wikiCheckpoints.$inferSelect;

/**
 * Wiki ページへの質問と回答から作った Q&A（#159）。ページの本文の下に出す。
 * 「このページについて質問」の会話の回答ごとに 1 つ作り、タスクとページの組ごとに見せる
 * （Wiki を共有していても、ほかのタスクの Q&A は混ぜない）。元の会話を消すと一緒に消える。
 */
export const wikiPageQas = sqliteTable(
  "wiki_page_qas",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** ページを削除しても会話の履歴とともに残すよう、外部キーにはしない（chats.wikiPageId と同じ）。 */
    wikiPageId: text("wiki_page_id").notNull(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    /** 元の回答（assistant メッセージ）の id。同じ回答から 2 つ作らない。 */
    messageId: text("message_id").notNull(),
    /** 会話を開かなくても意味が分かるように整えた質問。 */
    question: text("question").notNull(),
    /** 元の回答に沿って要約した回答。 */
    answer: text("answer").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    uniqueIndex("wiki_page_qas_message_idx").on(table.messageId),
    index("wiki_page_qas_task_page_idx").on(table.taskId, table.wikiPageId),
  ],
);

export type WikiPageQaRow = typeof wikiPageQas.$inferSelect;

/** タスクの関連リンク（GitHub リポジトリ・設計資料など、繰り返し開く URL）。 */
export const taskLinks = sqliteTable(
  "task_links",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** http / https の URL。 */
    url: text("url").notNull(),
    /** 表示名。無ければ URL を表示する。 */
    label: text("label"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [index("task_links_task_id_idx").on(table.taskId)],
);

export const QUEUE_STATUSES = ["pending", "sending", "held"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/**
 * 生成中に予約したメッセージ（#102）。会話（chats の行）ごとに、追加した順に 1 件ずつ送る。
 * 送るときは id をそのまま発話の id にするので、送信済みかどうかを発話の有無で確かめられる。
 */
export const queuedMessages = sqliteTable(
  "queued_messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    /** 送る順番。 */
    position: integer("position").notNull(),
    /** 送る発話の parts（JSON）。 */
    parts: text("parts", { mode: "json" }).notNull().$type<unknown[]>(),
    /**
     * pending: 送信待ち / sending: 送信中 /
     * held: 送信済みか分からない（サーバ再起動時の送信中など）。利用者に確かめてもらう
     */
    status: text("status", { enum: QUEUE_STATUSES })
      .notNull()
      .default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [index("queued_messages_chat_id_idx").on(table.chatId)],
);

export type TaskRow = typeof tasks.$inferSelect;
export type EnvironmentRow = typeof environments.$inferSelect;
export type QueuedMessageRow = typeof queuedMessages.$inferSelect;
export type TaskLinkRow = typeof taskLinks.$inferSelect;
export type WikiPageRow = typeof wikiPages.$inferSelect;
export type WikiRow = typeof wikis.$inferSelect;
export type ChatRow = typeof chats.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

/**
 * アプリ全体で 1 つだけ持つ値（キーごとに JSON）。
 * - `rate_limit`: 最後に観測した利用枠（#116）
 * - `chat_defaults`: 新規スレッドの初期値にする、最後に選んだモデルと effort（#164）
 */
export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull().$type<unknown>(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * ゴールの実行の状態（#198）。
 * - `running`: Claude がゴールに向けて作業している
 * - `needs_review`: 利用者の確認・判断・ツールの承認を待っている
 * - `achieved`: `/goal` の評価で達成を確認した
 * - `failed`: 達成不能・失敗
 * - `stopped`: 利用者が止めた
 */
export const GOAL_RUN_STATES = [
  "running",
  "needs_review",
  "achieved",
  "failed",
  "stopped",
] as const;
export type GoalRunState = (typeof GOAL_RUN_STATES)[number];

/**
 * タスクのゴールの実行（#198）。実行ごとにタスクに属するスレッドを 1 つ作り、
 * そのスレッドで Claude Code のネイティブの `/goal` を走らせる。
 * 同じタスクで進行中（running / needs_review）の実行は 1 つだけ（多重起動を防ぐ）。
 */
export const goalRuns = sqliteTable(
  "goal_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** 実行のために作ったスレッド（元の会話）。 */
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    /** 実行したときのゴール（あとでタスクのゴールを変えても残す）。 */
    goal: text("goal").notNull(),
    state: text("state", { enum: GOAL_RUN_STATES })
      .notNull()
      .default("running"),
    /** 状態の理由（評価の理由・停止や失敗の理由・確認してほしいこと）。 */
    reason: text("reason").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    index("goal_runs_task_id_idx").on(table.taskId),
    index("goal_runs_chat_id_idx").on(table.chatId),
    uniqueIndex("goal_runs_active_task_idx")
      .on(table.taskId)
      .where(sql`${table.state} in ('running', 'needs_review')`),
  ],
);

export type GoalRunRow = typeof goalRuns.$inferSelect;
