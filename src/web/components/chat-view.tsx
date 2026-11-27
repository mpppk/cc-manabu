import { useChat } from "@ai-sdk/react";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  BookOpen,
  ChevronRight,
  Folder,
  GitBranch,
  Loader2,
  Pencil,
  RotateCcw,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { resolveChatDefaults } from "../../chat/chat-defaults.ts";
import type { ChatUIMessage, Effort } from "../../chat/chat-service.ts";
import {
  type AnswerQuote,
  type QuoteData,
  quotesOf,
} from "../../chat/quote.ts";
import type { ChatDto, EnvironmentDto } from "../../router.ts";
import { citedPageIds, linkWikiCitations } from "../../wiki/citations.ts";
import {
  createTermMatcher,
  type TermEntry,
  type TermMatch,
} from "../../wiki/term-matcher.ts";
import { isPageTerm, normalizeTerm } from "../../wiki/terms.ts";
import { ChatDefaultsContext } from "../lib/chat-defaults.ts";
import { OrpcChatTransport, type SendSettings } from "../lib/chat-transport.ts";
import { branchLabel } from "../lib/groups.ts";
import { type ImageAttachment, imageFileParts } from "../lib/image.ts";
import { requestNotificationPermission } from "../lib/notify.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { pendingTermId } from "../lib/rehype-wiki-terms.ts";
import { pathForWiki } from "../lib/route.ts";
import { describeSteps, groupSteps } from "../lib/steps.ts";
import { formatUsage, totalUsage, usageOf } from "../lib/usage.ts";
import { cn } from "../lib/utils.ts";
import { AnswerWikiUndo, changedWiki } from "./answer-wiki-undo.tsx";
import { ApprovalCard } from "./approval-card.tsx";
import { BranchMenu } from "./branch-menu.tsx";
import { Composer } from "./composer.tsx";
import { EnvironmentPopover } from "./environment-popover.tsx";
import { Markdown, type WikiLinks } from "./markdown.tsx";
import { imagePartsOf, MessageImages } from "./message-images.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { PromptCacheTimer } from "./prompt-cache-timer.tsx";
import { QueuePanel, type QueueState } from "./queue-panel.tsx";
import { RateLimitBadge } from "./rate-limit-badge.tsx";
import { Reasoning } from "./reasoning.tsx";
import {
  type AskChoice,
  SelectionPopup,
  useTextSelection,
} from "./selection-popup.tsx";
import { StepGroup } from "./step-group.tsx";
import { isDenied, ToolCard } from "./tool-card.tsx";
import { Button } from "./ui/button.tsx";
import { WikiTermsContext, type WikiTermsContextValue } from "./wiki-term.tsx";

const textOf = (message: ChatUIMessage): string =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");

type Turn = {
  start: number;
  question?: ChatUIMessage;
  answers: ChatUIMessage[];
};

const groupTurns = (messages: ChatUIMessage[]): Turn[] => {
  const turns: Turn[] = [];
  let turn: Turn = { start: 0, answers: [] };
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      if (turn.question !== undefined || turn.answers.length > 0) {
        turns.push(turn);
      }
      turn = { start: index, question: message, answers: [] };
    } else {
      turn.answers.push(message);
    }
  }
  if (messages.length > 0) turns.push(turn);
  return turns;
};

const useAnswerDisclosure = (latestId: string | undefined) => {
  const [disclosure, setDisclosure] = useState({
    latestId,
    overrides: new Map<string, boolean>(),
  });
  if (disclosure.latestId !== latestId) {
    // 新旧の最新回答は既定の開閉状態に戻し、それ以外の手動操作は保つ。
    const overrides = new Map(disclosure.overrides);
    if (disclosure.latestId !== undefined)
      overrides.delete(disclosure.latestId);
    if (latestId !== undefined) overrides.delete(latestId);
    setDisclosure({ latestId, overrides });
  }
  const isOpen = (id: string) =>
    disclosure.overrides.get(id) ?? id === latestId;
  const setOpen = useCallback((id: string, open: boolean) => {
    setDisclosure((current) => {
      const overrides = new Map(current.overrides);
      if (open === (id === current.latestId)) overrides.delete(id);
      else overrides.set(id, open);
      return { ...current, overrides };
    });
  }, []);
  return { isOpen, setOpen };
};

/** ユーザー発話。生成中でなければ編集できる（それより後ろの会話は消える）。 */
const UserMessage = ({
  message,
  canEdit,
  onEdit,
}: {
  message: ChatUIMessage;
  canEdit: boolean;
  onEdit: (text: string) => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const images = imagePartsOf(message);
  const text = textOf(message);

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-2">
        <MessageImages images={images} />
        <textarea
          className="min-h-24 w-full max-w-[80%] resize-y rounded-2xl border bg-background px-4 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="発話を編集"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          送信すると、この発話より後ろの会話は消えて作り直されます。
          {images.length > 0 && "添付した画像はそのまま送られます。"}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
            キャンセル
          </Button>
          <Button
            size="sm"
            disabled={draft.trim() === ""}
            onClick={() => {
              setEditing(false);
              onEdit(draft.trim());
            }}
          >
            送信
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start justify-end gap-1">
      {canEdit && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label="この発話を編集"
          onClick={() => {
            setDraft(textOf(message));
            setEditing(true);
          }}
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
      <div className="flex max-w-[80%] flex-col items-end gap-2">
        {quotesOf(message.parts).map((quote, i) => (
          <QuoteBlock
            // biome-ignore lint/suspicious/noArrayIndexKey: パーツの順番は変わらない
            key={i}
            text={quote.text}
          />
        ))}
        <MessageImages images={images} />
        {text !== "" && (
          <div className="whitespace-pre-wrap rounded-2xl bg-secondary px-4 py-2">
            {text}
          </div>
        )}
      </div>
    </div>
  );
};

const MessageView = ({
  message,
  streaming,
  canAct,
  isLast,
  onRespond,
  onEdit,
  onRegenerate,
  onOpenWikiPage,
  termMatcher,
  onBranch,
  wikiUndo,
}: {
  message: ChatUIMessage;
  streaming: boolean;
  /** 生成中でなく、編集・再生成ができるか。 */
  canAct: boolean;
  isLast: boolean;
  onRespond: (
    approvalId: string,
    behavior: "allow" | "deny",
    reason: string | undefined,
  ) => Promise<void>;
  onEdit: (messageId: string, text: string) => void;
  onRegenerate: () => void;
  onOpenWikiPage?: (taskId: string, pageId: string) => void;
  /** 本文の用語を Wiki の用語ページに結び付ける（タスクの会話だけ）。 */
  termMatcher?: (text: string) => TermMatch[];
  /** この回答から分岐する（完了した回答だけ）。 */
  onBranch?: () => void;
  /** 回答で Claude が Wiki に加えた変更を元に戻す（タスクの会話だけ。#166）。 */
  wikiUndo?: { api: ApiClient; onChanged: () => void };
}) => {
  if (message.role === "user") {
    return (
      <UserMessage
        message={message}
        canEdit={canAct}
        onEdit={(text) => onEdit(message.id, text)}
      />
    );
  }
  const usage = streaming ? undefined : usageOf(message);
  // このターンで参照資料として渡した Wiki ページ。引用されたものだけをリンクにする
  const wiki = message.metadata?.wiki;
  const wikiIds = new Set(wiki?.pages.map((page) => page.id) ?? []);
  // 改名前（プロジェクト）に保存した回答は projectId に入っている
  const wikiTaskId = wiki?.taskId ?? wiki?.projectId;
  const wikiLinks: WikiLinks | undefined =
    wikiTaskId === undefined || onOpenWikiPage === undefined
      ? undefined
      : {
          href: (pageId) => pathForWiki(wikiTaskId, pageId),
          onOpen: (pageId) => onOpenWikiPage(wikiTaskId, pageId),
        };
  const cited = citedPageIds(
    message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n"),
    wikiIds,
  ).flatMap((id) => wiki?.pages.filter((page) => page.id === id) ?? []);
  const renderPart = (part: (typeof message.parts)[number], i: number) => {
    switch (part.type) {
      case "text":
        return (
          <Markdown
            key={i}
            text={linkWikiCitations(part.text, wikiIds)}
            streaming={streaming}
            cosenseLinks
            {...(wikiLinks === undefined ? {} : { wikiLinks })}
            {...(termMatcher === undefined ? {} : { termMatcher })}
          />
        );
      case "reasoning":
        return (
          <Reasoning
            key={i}
            text={part.text}
            streaming={streaming && part.state === "streaming"}
          />
        );
      case "dynamic-tool":
        return <ToolCard key={part.toolCallId} part={part} />;
      case "data-approval":
        // 承認待ちのカードは回答を閉じても操作できる位置に出す。
        return part.data.status === "pending" ? null : (
          <ApprovalCard
            key={part.data.approvalId}
            approval={part.data}
            onRespond={(behavior, reason) =>
              onRespond(part.data.approvalId, behavior, reason)
            }
          />
        );
      default:
        return null;
    }
  };
  // 思考・ツールの実行が続くところは、1 つの「手順」にまとめて開閉できるようにする
  const segments = groupSteps(
    message.parts,
    (part) =>
      part.type === "dynamic-tool" ||
      (part.type === "reasoning" &&
        (part.text.trim() !== "" || (streaming && part.state === "streaming"))),
    (part) =>
      part.type === "step-start" ||
      (part.type === "reasoning" &&
        part.text.trim() === "" &&
        !(streaming && part.state === "streaming")),
  );
  return (
    <div className="flex flex-col gap-2" data-assistant-message={message.id}>
      {segments.map((segment, s) => {
        if (segment.kind === "single") {
          return renderPart(segment.part, segment.index);
        }
        const tools = segment.items.flatMap(({ part }) =>
          part.type === "dynamic-tool" ? [part] : [],
        );
        const running = tools.some(
          (tool) =>
            tool.state !== "output-available" && tool.state !== "output-error",
        );
        const failed = tools.some(
          (tool) => tool.state === "output-error" && !isDenied(tool),
        );
        return (
          <StepGroup
            key={`steps-${segment.items[0]?.index ?? s}`}
            count={segment.items.length}
            breakdown={describeSteps(
              segment.items.map(({ part }) =>
                part.type === "dynamic-tool" ? part.toolName : "思考",
              ),
            )}
            live={streaming && s === segments.length - 1}
            status={
              running ? (
                <Loader2
                  className="size-3.5 shrink-0 animate-spin"
                  aria-label="実行中"
                />
              ) : failed ? (
                <X
                  className="size-3.5 shrink-0 text-destructive"
                  aria-label="エラーあり"
                />
              ) : undefined
            }
          >
            {segment.items.map(({ part, index }) => renderPart(part, index))}
          </StepGroup>
        );
      })}
      {!streaming && cited.length > 0 && wikiLinks !== undefined && (
        <nav
          aria-label="参照した Wiki"
          className="flex flex-wrap items-center gap-1.5 text-xs"
        >
          <span className="text-muted-foreground">参照した Wiki:</span>
          {cited.map((page) => (
            <a
              key={page.id}
              href={wikiLinks.href(page.id)}
              className="rounded-full border px-2 py-0.5 hover:bg-accent"
              onClick={(event) => {
                event.preventDefault();
                wikiLinks.onOpen(page.id);
              }}
            >
              {page.title}
            </a>
          ))}
        </nav>
      )}
      {wiki?.excerpted === true && (
        <p className="text-muted-foreground text-xs">
          ノートの抜粋を参照しました。
        </p>
      )}
      <div className="flex items-center gap-2">
        {usage !== undefined && (
          <p className="text-muted-foreground text-xs">
            {message.metadata?.model !== undefined &&
              `${message.metadata.model}・`}
            {formatUsage(usage)}
            {message.metadata?.aborted === true && "・中断"}
          </p>
        )}
        {isLast && canAct && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground text-xs"
            onClick={onRegenerate}
          >
            <RotateCcw className="size-3.5" />
            再生成
          </Button>
        )}
        {canAct && onBranch !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground text-xs"
            onClick={onBranch}
          >
            <GitBranch className="size-3.5" />
            ここから分岐
          </Button>
        )}
        {!streaming && wikiUndo !== undefined && changedWiki(message) && (
          <AnswerWikiUndo
            api={wikiUndo.api}
            messageId={message.id}
            onChanged={wikiUndo.onChanged}
          />
        )}
      </div>
    </div>
  );
};

/** パスの最後のフォルダ名（入力欄の下に出す。全体は title で見せる）。 */
const folderName = (cwd: string): string =>
  cwd
    .split(/[\\/]/)
    .filter((part) => part !== "")
    .at(-1) ?? cwd;

const UsageTotal = ({ messages }: { messages: ChatUIMessage[] }) => {
  const total = totalUsage(messages);
  if (total.costUsd === 0 && total.durationMs === 0) {
    return null;
  }
  return (
    <span
      className="truncate text-muted-foreground text-xs"
      title="この会話の合計"
    >
      合計 {formatUsage(total)}
    </span>
  );
};

/** 質問の対象として引用した回答の一部。 */
export const QuoteBlock = ({ text }: { text: string }) => (
  <blockquote className="max-h-40 w-full overflow-y-auto whitespace-pre-wrap border-l-4 border-sky-500/60 bg-muted/50 px-3 py-2 text-left text-muted-foreground text-sm">
    {text}
  </blockquote>
);

/**
 * ノートから質問して始めたスレッドで、元のノートを示す。
 * スレッドのタイトルは最初の回答のあとで付け直す（#161）ので、どのノートからかはここで分かるようにする。
 */
const WikiSourceNote = ({
  api,
  pageId,
  onOpen,
}: {
  api: ApiClient;
  pageId: string;
  /** 元のノートを開く。タスクから外れたスレッドなど、開けなければ undefined。 */
  onOpen: (() => void) | undefined;
}) => {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; title: string }
    | { status: "missing" }
  >({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    api.wiki
      .get({ id: pageId })
      .then((page) => {
        if (!cancelled) setState({ status: "ready", title: page.title });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [api, pageId]);
  return (
    <div
      role="note"
      aria-label="元のノート"
      className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
    >
      <BookOpen aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      {state.status === "missing" ? (
        <span className="text-muted-foreground">
          このスレッドを始めたノートは削除されました。
        </span>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted-foreground">ノート </span>
            {state.status === "ready" ? (
              <span className="font-medium" title={state.title}>
                {state.title}
              </span>
            ) : (
              <span className="text-muted-foreground">…</span>
            )}
            <span className="text-muted-foreground"> から質問したスレッド</span>
          </span>
          {onOpen !== undefined && state.status === "ready" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={onOpen}
            >
              ノートを開く
            </Button>
          )}
        </>
      )}
    </div>
  );
};

/** 分岐元から引き継いだ履歴と、この会話で書いた履歴の境目。 */
const InheritedDivider = ({ parent }: { parent: ChatDto | undefined }) => (
  <div className="flex items-center gap-2 text-muted-foreground text-xs">
    <span className="h-px flex-1 bg-border" />
    <GitBranch className="size-3.5" />
    {parent === undefined
      ? "ここから分岐"
      : `ここまで「${branchLabel(parent)}」から引き継いだ履歴`}
    <span className="h-px flex-1 bg-border" />
  </div>
);

/** 用語の照合を取り直す間隔（自動作成・編集されたページを反映する）。 */
const TERMS_REFRESH_MS = 10_000;

/**
 * タスクの用語ページ（タイトルと別名）から、本文の用語の照合を作る。
 * 生成中の語句（generating）も、生成中の表示にするために照合に含める。
 */
const useTaskTerms = (
  api: ApiClient,
  taskId: string | null,
  generating: readonly string[],
) => {
  const [entries, setEntries] = useState<TermEntry[]>([]);
  const refreshTerms = useCallback(async () => {
    if (taskId === null) return;
    await api.wiki
      .list({ taskId })
      .then((pages) => {
        const next = pages.map((page) => ({
          pageId: page.id,
          names: [page.title, ...page.aliases],
        }));
        // 変わっていなければ照合を作り直さない（本文の再描画を避ける）
        setEntries((current) =>
          JSON.stringify(current) === JSON.stringify(next) ? current : next,
        );
      })
      .catch(() => {});
  }, [api, taskId]);
  useEffect(() => {
    void refreshTerms();
    const timer = setInterval(() => void refreshTerms(), TERMS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshTerms]);
  const termMatcher = useMemo(() => {
    const all = [
      ...entries,
      ...generating.map((term) => ({
        pageId: pendingTermId(term),
        names: [term],
      })),
    ];
    return taskId === null || all.length === 0
      ? undefined
      : createTermMatcher(all);
  }, [taskId, entries, generating]);
  return { termMatcher, refreshTerms };
};

/** 回答の要約を取り直す間隔と回数（要約は回答のあとにサーバが作る）。 */
const SUMMARY_POLL_MS = 1500;
const SUMMARY_POLL_TRIES = 10;

/**
 * 回答の要約（メッセージ id → 要約）。読み込んだメッセージの metadata にあればそれを使い、
 * 回答が終わったら、その回答の要約が届くまで少しのあいだ取り直す。
 */
const useAnswerSummaries = (api: ApiClient, chatId: string) => {
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const waitFor = useCallback(
    (messageId: string) => {
      clearTimeout(timer.current);
      let tries = 0;
      const poll = () => {
        tries += 1;
        const retry = () => {
          if (tries < SUMMARY_POLL_TRIES) {
            timer.current = setTimeout(poll, SUMMARY_POLL_MS);
          }
        };
        api.chats.summaries({ id: chatId }).then((next) => {
          setSummaries((current) => ({ ...current, ...next }));
          if (next[messageId] === undefined) retry();
        }, retry);
      };
      timer.current = setTimeout(poll, SUMMARY_POLL_MS);
    },
    [api, chatId],
  );
  const summaryOf = (answers: ChatUIMessage[]): string | undefined =>
    answers
      .map((message) => summaries[message.id] ?? message.metadata?.summary)
      .findLast((summary) => summary !== undefined);
  return { summaryOf, waitFor };
};

/** 予約（#102）を取り直す間隔。 */
const QUEUE_POLL_MS = 1000;

/**
 * 会話の予約（#102）。予約はサーバが送るので、送られたら（予約が消えた・サーバで生成中になった）
 * onServerSend で画面に映す。
 */
const useQueue = (
  api: ApiClient,
  chatId: string,
  busy: boolean,
  onServerSend: () => void,
) => {
  const [state, setState] = useState<QueueState>();
  const known = useRef(new Set<string>());
  const missed = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onServerSendRef = useRef(onServerSend);
  onServerSendRef.current = onServerSend;

  const refresh = useCallback(async () => {
    const next = await api.queue.list({ chatId }).catch(() => undefined);
    if (next === undefined) return;
    const ids = new Set(next.items.map((item) => item.id));
    if ([...known.current].some((id) => !ids.has(id))) missed.current = true;
    known.current = ids;
    setState((current) =>
      JSON.stringify(current) === JSON.stringify(next) ? current : next,
    );
    if (!busyRef.current && (missed.current || next.active)) {
      missed.current = false;
      onServerSendRef.current();
    }
  }, [api, chatId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), QUEUE_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /** 利用者が取り消した予約は、送られたものとして扱わない。 */
  const forget = (id: string) => {
    known.current.delete(id);
  };
  return { state, refresh, forget };
};

export type ChatViewProps = {
  /**
   * 渡すと、回答の選択範囲から Wiki のページを AI で作れる（タスクの会話だけ、#121）。
   * ページを作ったあとに呼ぶ。
   */
  onWikiPageCreated?: (taskId: string) => void;
  /** 検索結果から開いたときに移動する発言（#115）。 */
  focusMessage?: { messageId: string };
  api: ApiClient;
  chat: ChatDto;
  /** 同じスレッドの会話（#76）。2 つ以上あれば切り替えメニューを出す。 */
  branches?: ChatDto[];
  /** 会話を開く（分岐して作った会話を開くのにも使う）。 */
  onSelectBranch?: (chatId: string) => void;
  /** メインで開いている会話を保ったまま、同じスレッドの別の会話をサイドで開く。 */
  onOpenSideBranch?: (chatId: string) => void;
  initialMessages: ChatUIMessage[];
  /** 選べるモデル（system.status から）。 */
  models: ModelInfo[];
  /** 送信・完了など、一覧の表示（タイトル・状態）が変わりうるときに呼ぶ。 */
  onActivity?: () => void;
  /** 回答から引用された Wiki ページを開く（Wiki 画面へ移る）。 */
  onOpenWikiPage?: (taskId: string, pageId: string) => void;
  /**
   * 回答中の用語・引用した Wiki ページを、会話の右側のペインで開く。
   * あれば、用語や引用リンクのクリックは Wiki 画面へ移らずにこちらを使う。
   */
  onOpenWikiPane?: (taskId: string, pageId: string) => void;
  side?: boolean;
  onAskSelection?: (quote: AnswerQuote, settings: SendSettings) => void;
  /**
   * 次に送るメッセージに添える引用（Wiki ページの本文から選んだ部分など）。
   * 入力欄の上に出し、送ったら onClearQuote を呼ぶ。
   */
  pendingQuote?: QuoteData | undefined;
  onClearQuote?: () => void;
  /** 作業フォルダ（入力欄の下に出す）。 */
  cwd?: string;
  /** スレッドが属するタスクの環境（入力欄の下に名前を出し、押すと詳細を開く。#192）。 */
  environment?: EnvironmentDto | undefined;
  /** 入力欄の下にサブスクリプションの利用枠を出す（メインのチャットだけ。#170）。 */
  showRateLimit?: boolean;
  /** 会話の切り替えを出す、画面上部のヘッダーの領域（メインのチャットだけ。#234）。 */
  headerSlot?: HTMLElement | null | undefined;
  /** 新しい回答の印が付いた会話（#234）。 */
  unreadChatIds?: ReadonlySet<string>;
};

const NO_UNREAD: ReadonlySet<string> = new Set();

/** 1 つの会話を表示し、その会話の ID で送信・再接続する。 */
export const ChatView = ({
  api,
  chat,
  initialMessages,
  models,
  onActivity,
  onOpenWikiPage,
  onOpenWikiPane,
  branches = [],
  onSelectBranch,
  onOpenSideBranch,
  focusMessage,
  onWikiPageCreated,
  side = false,
  onAskSelection,
  pendingQuote,
  onClearQuote,
  cwd,
  environment,
  showRateLimit = false,
  headerSlot,
  unreadChatIds = NO_UNREAD,
}: ChatViewProps) => {
  const chatDefaults = useContext(ChatDefaultsContext);
  /**
   * まだ何も送っていない新規スレッド。最後に選んだモデルと effort を初期値にする（#164）。
   * 分岐した会話・送信済みの会話は、その会話の保存済みの設定を使う。
   */
  const fresh =
    initialMessages.length === 0 && chat.parentId === null && !chat.hasSession;
  const [settings, setSettings] = useState<{
    model: string;
    effort: Effort | null;
  }>(() =>
    fresh
      ? resolveChatDefaults(chatDefaults.defaults, models)
      : { model: chat.model, effort: (chat.effort as Effort | null) ?? null },
  );
  /** この会話で利用者がモデルか effort を選んだか。選んだら初期値で上書きしない。 */
  const pickedSettings = useRef(false);
  // transport は作り直さず、送信時に最新の設定を読む
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  /** 選択範囲から AI で作っている最中のページの語句。 */
  const [generatingTerms, setGeneratingTerms] = useState<string[]>([]);
  /** ページ作成の結果（すでにある・失敗）を、元の回答の下に少しのあいだ出す。 */
  const [termNotice, setTermNotice] = useState<{
    messageId: string;
    text: string;
    tone: "info" | "error";
  }>();
  useEffect(() => {
    if (termNotice === undefined) return;
    const timer = setTimeout(() => setTermNotice(undefined), 8000);
    return () => clearTimeout(timer);
  }, [termNotice]);
  const { termMatcher, refreshTerms } = useTaskTerms(
    api,
    chat.taskId,
    generatingTerms,
  );
  // 引用リンクは、ペインがあればペインで開く
  const openWikiPage = onOpenWikiPane ?? onOpenWikiPage;
  const wikiTerms = useMemo<WikiTermsContextValue | undefined>(
    () =>
      chat.taskId === null || onOpenWikiPage === undefined
        ? undefined
        : {
            load: (pageId) =>
              api.wiki.get({ id: pageId }).catch(() => undefined),
            open: (pageId) =>
              chat.taskId !== null && onOpenWikiPage(chat.taskId, pageId),
            openPane:
              onOpenWikiPane === undefined
                ? undefined
                : (pageId) =>
                    chat.taskId !== null && onOpenWikiPane(chat.taskId, pageId),
          },
    [api, chat.taskId, onOpenWikiPage, onOpenWikiPane],
  );
  const { summaryOf, waitFor: waitForSummary } = useAnswerSummaries(
    api,
    chat.id,
  );
  const transport = useMemo(
    () => new OrpcChatTransport(api, () => settingsRef.current),
    [api],
  );
  const {
    messages,
    sendMessage,
    regenerate,
    status,
    stop,
    error,
    setMessages,
    resumeStream,
  } = useChat<ChatUIMessage>({
    id: chat.id,
    messages: initialMessages,
    transport,
    // リロード時に生成中なら、途中から表示する
    resume: true,
    onFinish: ({ message, isAbort, isError }) => {
      onActivity?.();
      // 回答のあとに要約が作られるので、届くまで取り直す
      if (!isAbort && !isError && message.role === "assistant") {
        waitForSummary(message.id);
      }
      // 予約があれば、サーバが次を送る
      setTimeout(() => void queue.refresh(), 200);
      // 回答のあとに用語ページが自動で作られるので、少し待ってから取り直す
      setTimeout(() => void refreshTerms(), 3000);
    },
  });
  // 初期値や選べるモデルを読み込み終えたら、送る前の新規スレッドに反映する
  const unsent = messages.length === 0;
  useEffect(() => {
    if (!fresh || !unsent || pickedSettings.current) return;
    setSettings(resolveChatDefaults(chatDefaults.defaults, models));
  }, [fresh, unsent, chatDefaults.defaults, models]);
  const busy = status === "submitted" || status === "streaming";
  const turns = useMemo(() => groupTurns(messages), [messages]);
  const latestTurn = busy
    ? turns.at(-1)
    : turns.findLast((turn) =>
        turn.answers.some((m) => m.role === "assistant"),
      );
  const { isOpen, setOpen } = useAnswerDisclosure(latestTurn?.question?.id);

  /** サーバが予約を送ったら、保存された会話を読み直して生成の続きを受け取る。 */
  const syncing = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const syncFromServer = async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      const latest = await api.chats.get({ id: chat.id });
      if (busyRef.current) return;
      setMessages(latest.messages as ChatUIMessage[]);
      onActivity?.();
      if (
        latest.chat.status === "running" ||
        latest.chat.status === "awaiting_approval"
      ) {
        await resumeStream();
      }
    } catch {
      // 次の取り直しで追いつく
    } finally {
      syncing.current = false;
    }
  };
  const queue = useQueue(api, chat.id, busy, () => void syncFromServer());
  const queueState = queue.state;
  const queueing =
    busy ||
    (queueState !== undefined &&
      !queueState.paused &&
      queueState.items.some((item) => item.status !== "held"));

  /** 「ここから分岐」で選んだ回答（HEAD）。送信すると新しい会話を作る。取り消すと元に戻る。 */
  const [branchFrom, setBranchFrom] = useState<string>();
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [branchError, setBranchError] = useState<string>();
  /**
   * 回答の選択範囲から、この会話（branch なら選んだ回答から分岐する新しい会話）に添える引用（#222）。
   * 外から渡す pendingQuote（Wiki ページの引用）があれば、そちらを使う。
   */
  const [ownQuote, setOwnQuote] = useState<{
    quote: AnswerQuote;
    branch: boolean;
  }>();
  const transcript = useRef<HTMLDivElement>(null);
  // 回答の選択範囲は、どの会話でも引用して質問できる（#222）
  const selection = useTextSelection(
    transcript,
    "data-assistant-message",
    true,
  );
  const selectedMessageId = selection?.sourceId;
  const cancelBranch = () => {
    setBranchFrom(undefined);
    setBranchError(undefined);
    // 分岐して質問するための引用も、一緒に取り消す
    setOwnQuote((current) => (current?.branch === true ? undefined : current));
  };
  const selectedTurn =
    selection === undefined
      ? undefined
      : turns.find((turn) =>
          turn.answers.some((m) => m.id === selectedMessageId),
        );
  const selectedAnswer =
    (!busy || selectedMessageId !== messages.at(-1)?.id) &&
    (selectedTurn?.question === undefined || isOpen(selectedTurn.question.id))
      ? selectedTurn?.answers.find((m) => m.id === selectedMessageId)
      : undefined;
  /** 選んだ回答から分岐できるか（分岐元の回答の位置が分かるか）。 */
  const branchable =
    selection !== undefined &&
    selectedAnswer?.metadata?.claudeCode?.lastAssistantUuid !== undefined;
  const selectedQuote = (): AnswerQuote | undefined =>
    selection === undefined
      ? undefined
      : { text: selection.text, sourceMessageId: selection.sourceId };
  const askSelection =
    branchable && onAskSelection !== undefined
      ? () => {
          const quote = selectedQuote();
          if (quote === undefined) return;
          onAskSelection(quote, settingsRef.current);
          window.getSelection()?.removeAllRanges();
        }
      : undefined;
  /** 表示中の会話に、引用を添えて続ける（#222）。 */
  const quoteHere =
    selection !== undefined
      ? () => {
          const quote = selectedQuote();
          if (quote === undefined) return;
          setBranchFrom(undefined);
          setBranchError(undefined);
          setOwnQuote({ quote, branch: false });
          window.getSelection()?.removeAllRanges();
        }
      : undefined;
  /** 選んだ回答を起点に、同じスレッドの別の会話へ分岐して質問する（サイドチャット。#222）。 */
  const branchWithQuote =
    branchable && side && selectedAnswer !== undefined
      ? () => {
          const quote = selectedQuote();
          if (quote === undefined) return;
          setBranchError(undefined);
          setBranchFrom(selectedAnswer.id);
          setOwnQuote({ quote, branch: true });
          window.getSelection()?.removeAllRanges();
        }
      : undefined;
  const askChoices: AskChoice[] = side
    ? [
        {
          label: "このサイドチャットで続ける",
          onClick: quoteHere,
          title: "選んだ部分を引用して、このサイドチャットで質問します",
        },
        {
          label: "別の会話に分岐して質問",
          onClick: branchWithQuote,
          title:
            branchWithQuote === undefined
              ? "この回答からは分岐できません"
              : "選んだ回答を起点に、同じスレッドの新しい会話で質問します（送信したときに作ります）",
        },
      ]
    : [
        {
          label: "この会話で続ける",
          onClick: quoteHere,
          title: "選んだ部分を引用して、表示中の会話で質問します",
        },
        ...(onAskSelection === undefined
          ? []
          : [
              {
                label: "サイドチャットで質問",
                onClick: askSelection,
                title:
                  askSelection === undefined
                    ? "この回答からは分岐できません"
                    : "選んだ回答を起点に、新しいサイドチャットで質問します",
              },
            ]),
      ];
  const taskId = chat.taskId;
  /** 選んだ語句の Wiki のページを AI で作る。画面は移らず、できたら用語として表示する。 */
  const generatePage = async (messageId: string, term: string) => {
    if (taskId === null) return;
    setTermNotice(undefined);
    setGeneratingTerms((current) => [...current, term]);
    try {
      const { page, created } = await api.wiki.generate({
        chatId: chat.id,
        messageId,
        term,
      });
      await refreshTerms();
      onWikiPageCreated?.(taskId);
      if (!created) {
        setTermNotice({
          messageId,
          tone: "info",
          text: `「${page.title}」のノートはすでにあります。`,
        });
      }
    } catch {
      setTermNotice({
        messageId,
        tone: "error",
        text: `「${term}」のノートを作成できませんでした。もう一度お試しください。`,
      });
    } finally {
      setGeneratingTerms((current) => current.filter((t) => t !== term));
    }
  };
  const selectedTerm = selection?.text.trim();
  const createPageBlocker =
    environment !== undefined && environment.wikiId === null
      ? "この環境は Wiki を使っていないので、ノートを作れません"
      : taskId === null || onWikiPageCreated === undefined
        ? "タスクの会話でだけ、ノートを作れます"
        : selectedTerm === undefined || !isPageTerm(selectedTerm)
          ? "1 行・2〜40 文字の語句を選ぶと、ノートを作れます"
          : generatingTerms.some(
                (term) => normalizeTerm(term) === normalizeTerm(selectedTerm),
              )
            ? "この語句のノートを作成しています"
            : undefined;
  const createPageFromSelection =
    selection !== undefined &&
    selectedTerm !== undefined &&
    createPageBlocker === undefined
      ? () => {
          void generatePage(selection.sourceId, selectedTerm);
          window.getSelection()?.removeAllRanges();
        }
      : undefined;
  const branchIndex =
    branchFrom === undefined
      ? -1
      : messages.findIndex((message) => message.id === branchFrom);
  const visibleCount = branchIndex < 0 ? messages.length : branchIndex + 1;
  const firstVisible = side ? chat.inheritedCount : 0;

  // 検索結果から開いた発言へ移動し、しばらく強調する
  const [highlighted, setHighlighted] = useState<typeof focusMessage>();
  const focusMessageId = focusMessage?.messageId;
  const focusIndex = messages.findIndex((m) => m.id === focusMessageId);
  const focusVisible = focusIndex >= 0 && focusIndex < visibleCount;
  const focusAnswerId = turns.find((turn) =>
    turn.answers.some((m) => m.id === focusMessageId),
  )?.question?.id;
  useEffect(() => {
    if (focusMessage === undefined || !focusVisible) {
      setHighlighted(undefined);
      return;
    }
    if (focusAnswerId !== undefined) setOpen(focusAnswerId, true);
    setHighlighted(focusMessage);
    const timer = setTimeout(() => setHighlighted(undefined), 2500);
    return () => clearTimeout(timer);
  }, [focusMessage, focusVisible, focusAnswerId, setOpen]);
  useEffect(() => {
    if (highlighted === undefined) return;
    document
      .querySelector(`[data-message-id="${CSS.escape(highlighted.messageId)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [highlighted]);

  const createBranch = async (
    parentMessageId: string,
    parts: ChatUIMessage["parts"],
  ) => {
    setCreatingBranch(true);
    setBranchError(undefined);
    const branchId = crypto.randomUUID();
    try {
      const { model, effort } = settingsRef.current;
      await api.chat.branch({
        parentId: chat.id,
        messageId: parentMessageId,
        branchId,
        message: { id: crypto.randomUUID(), role: "user", parts },
        model,
        ...(effort === undefined ? {} : { effort }),
      });
      cancelBranch();
      onActivity?.();
      onSelectBranch?.(branchId);
      return true;
    } catch (error) {
      setBranchError(
        error instanceof Error ? error.message : "分岐できませんでした。",
      );
      return false;
    } finally {
      setCreatingBranch(false);
    }
  };

  const [queueError, setQueueError] = useState<string>();
  const queueAction = async (action: () => Promise<unknown>) => {
    setQueueError(undefined);
    try {
      await action();
    } catch (error) {
      setQueueError(
        error instanceof Error ? error.message : "予約を変更できませんでした。",
      );
    }
    await queue.refresh();
  };

  /** 次に送るメッセージに添える引用。 */
  const quote: QuoteData | undefined = pendingQuote ?? ownQuote?.quote;
  const clearQuote = () => {
    if (pendingQuote !== undefined) {
      onClearQuote?.();
      return;
    }
    if (ownQuote?.branch === true) cancelBranch();
    setOwnQuote(undefined);
  };
  /** 送るメッセージの parts（添える引用・画像・本文）。 */
  const partsOf = (
    text: string,
    images: ImageAttachment[],
  ): ChatUIMessage["parts"] => [
    ...(quote === undefined
      ? []
      : [{ type: "data-quote" as const, data: quote }]),
    ...imageFileParts(images),
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
  ];
  /**
   * 現在地を維持して送る分岐元（#225）。HEAD までの、生成中でない最後の回答。
   * 生成中は、生成中のターン（最後の質問とその回答）を除いた最後の回答から分岐するので、
   * 回答を待たずに次々と質問できる。HEAD は動かさない。
   * 送れないときは理由。メインのチャットで、分岐をサイドで開けるときだけ使う。
   */
  const generatingFrom =
    busy && branchFrom === undefined
      ? messages.findLastIndex((message) => message.role === "user")
      : -1;
  const branchBase = messages
    .slice(0, generatingFrom >= 0 ? generatingFrom : visibleCount)
    .findLast((message) => message.role === "assistant");
  const branchSendBlocker =
    branchBase === undefined
      ? busy
        ? "生成が終わった回答がまだありません。最初の回答が終わってから送ってください。"
        : "分岐元の回答がまだありません。回答が届いてから送ってください。"
      : branchBase.metadata?.claudeCode?.lastAssistantUuid === undefined
        ? "この回答からは分岐できません。"
        : creatingBranch
          ? "分岐を作成しています。"
          : undefined;
  const sendToBranch = async (text: string, images: ImageAttachment[]) => {
    if (branchSendBlocker !== undefined || branchBase === undefined) {
      return false;
    }
    if (onOpenSideBranch === undefined) return false;
    requestNotificationPermission();
    setCreatingBranch(true);
    setBranchError(undefined);
    const branchId = crypto.randomUUID();
    try {
      const { model, effort } = settingsRef.current;
      await api.chat.branch({
        parentId: chat.id,
        messageId: branchBase.id,
        branchId,
        message: {
          id: crypto.randomUUID(),
          role: "user",
          parts: partsOf(text, images),
        },
        model,
        ...(effort === undefined ? {} : { effort }),
      });
      // メインの会話と現在地（HEAD）はそのまま。回答はサイドチャットに出す
      quoteSent();
      onActivity?.();
      onOpenSideBranch(branchId);
      return true;
    } catch (failure) {
      setBranchError(
        (failure as { code?: unknown } | undefined)?.code ===
          "TOO_MANY_REQUESTS"
          ? "同時に生成できる会話の数の上限に達しています。どれかの回答が終わってから送ってください（入力した内容はそのまま残ります）。"
          : failure instanceof Error
            ? failure.message
            : "分岐できませんでした。",
      );
      return false;
    } finally {
      setCreatingBranch(false);
    }
  };

  /** 送ったので、添えた引用を外す（分岐の取り消しはしない）。 */
  const quoteSent = () => {
    onClearQuote?.();
    setOwnQuote(undefined);
  };

  const enqueue = (text: string, images: ImageAttachment[]) => {
    requestNotificationPermission();
    const parts = partsOf(text, images);
    quoteSent();
    void queueAction(() =>
      api.queue.add({
        chatId: chat.id,
        message: { id: crypto.randomUUID(), role: "user", parts },
      }),
    );
  };

  const submit = (text: string, images: ImageAttachment[]) => {
    if (busy || creatingBranch) return;
    requestNotificationPermission();
    const parts = partsOf(text, images);
    quoteSent();
    if (branchFrom !== undefined) {
      return createBranch(branchFrom, parts);
    }
    void sendMessage({ parts }).then(() => onActivity?.());
    // タイトルと状態（生成中）をすぐ一覧に反映する
    setTimeout(() => onActivity?.(), 300);
  };

  // 引用を添えたら、続けて質問を書けるよう入力欄に移る
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (quote === undefined) return;
    root.current
      ?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])")
      ?.focus();
  }, [quote]);

  const onStop = async () => {
    // サーバ側の生成を止めてから、購読を切る
    await api.chat.stop({ chatId: chat.id });
    await stop();
    await queue.refresh();
  };

  const respond = async (
    approvalId: string,
    behavior: "allow" | "deny",
    reason: string | undefined,
  ) => {
    await api.approvals.respond({
      chatId: chat.id,
      approvalId,
      behavior,
      ...(reason === undefined ? {} : { message: reason }),
    });
    onActivity?.();
  };

  const renderMessage = (message: ChatUIMessage, index: number) => (
    <Fragment key={message.id}>
      {!side && chat.inheritedCount > 0 && index === chat.inheritedCount && (
        <InheritedDivider
          parent={branches.find((b) => b.id === chat.parentId)}
        />
      )}
      <div
        data-message-id={message.id}
        className={cn(
          "rounded-lg transition-shadow",
          highlighted?.messageId === message.id &&
            "ring-2 ring-amber-400 ring-offset-4 ring-offset-background",
        )}
      >
        <MessageView
          message={message}
          {...(chat.taskId === null
            ? {}
            : {
                wikiUndo: {
                  api,
                  onChanged: () => {
                    void refreshTerms();
                    onActivity?.();
                  },
                },
              })}
          streaming={busy && index === messages.length - 1}
          canAct={!busy && branchFrom === undefined}
          isLast={index === messages.length - 1}
          {...(!side &&
          message.role === "assistant" &&
          message.metadata?.claudeCode?.lastAssistantUuid !== undefined
            ? {
                onBranch: () => {
                  setBranchError(undefined);
                  setBranchFrom(
                    message.id === messages.at(-1)?.id ? undefined : message.id,
                  );
                },
              }
            : {})}
          onEdit={(messageId, text) => {
            // 画像はサーバでもそのまま送られる。表示からも消えないように付け直す
            const files = imagePartsOf(message);
            setOpen(messageId, true);
            void sendMessage({ text, files, messageId }).then(() =>
              onActivity?.(),
            );
          }}
          onRegenerate={() => {
            void regenerate().then(() => onActivity?.());
          }}
          {...(openWikiPage === undefined
            ? {}
            : { onOpenWikiPage: openWikiPage })}
          {...(termMatcher === undefined ? {} : { termMatcher })}
          onRespond={respond}
        />
        {message.role === "assistant" &&
          termNotice?.messageId === message.id && (
            <p
              role={termNotice.tone === "error" ? "alert" : "status"}
              className={cn(
                "mt-2 text-xs",
                termNotice.tone === "error"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {termNotice.text}
            </p>
          )}
      </div>
    </Fragment>
  );

  // 会話の切り替えは、画面上部のヘッダーに出す（#234）
  const branchMenu =
    !side &&
    headerSlot != null &&
    branches.length > 1 &&
    createPortal(
      <BranchMenu
        current={chat}
        branches={branches}
        unread={unreadChatIds}
        disabled={branchFrom !== undefined}
        onSelect={(id) => onSelectBranch?.(id)}
        onOpenSide={onOpenSideBranch}
      />,
      headerSlot,
    );

  return (
    <WikiTermsContext.Provider value={wikiTerms}>
      {branchMenu}
      {selection !== undefined && selectedAnswer !== undefined && (
        <SelectionPopup
          selection={selection}
          ask={{
            onClick: undefined,
            title: "選んだ部分を引用して質問します（続ける会話を選べます）",
          }}
          askChoices={askChoices}
          createPage={{
            onClick: createPageFromSelection,
            title:
              createPageBlocker ??
              "選んだ語句のノートを AI で作ります（画面は移りません）",
          }}
        />
      )}
      <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={transcript} className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
            {!side && chat.wikiPageId !== null && (
              <WikiSourceNote
                api={api}
                pageId={chat.wikiPageId}
                onOpen={
                  chat.taskId === null || openWikiPage === undefined
                    ? undefined
                    : () => {
                        if (chat.taskId !== null && chat.wikiPageId !== null) {
                          openWikiPage(chat.taskId, chat.wikiPageId);
                        }
                      }
                }
              />
            )}
            {turns
              .filter(
                ({ start }) => start >= firstVisible && start < visibleCount,
              )
              .map((turn) => {
                const { question, start } = turn;
                const answerStart = question === undefined ? start : start + 1;
                const answers = turn.answers.slice(
                  0,
                  visibleCount - answerStart,
                );
                const pending = answers.flatMap((message) =>
                  message.parts.flatMap((part) =>
                    part.type === "data-approval" &&
                    part.data.status === "pending"
                      ? [part.data]
                      : [],
                  ),
                );
                const open = question === undefined || isOpen(question.id);
                const answerId = `answer-${question?.id ?? answers[0]?.id}`;
                const hasAnswer =
                  answers.length > 0 || (busy && turn === latestTurn);
                // 閉じている回答は、「回答を開く」の代わりに要約を出す
                const summary = open ? undefined : summaryOf(answers);
                const current =
                  !side && answerStart + answers.length === visibleCount;
                return (
                  <div
                    key={question?.id ?? answers[0]?.id}
                    className="flex flex-col gap-3"
                  >
                    {question !== undefined && renderMessage(question, start)}
                    <div className="flex items-center justify-end gap-2 empty:hidden">
                      {current && (
                        <span
                          className="rounded-md bg-muted px-2 py-1 text-muted-foreground text-xs"
                          title="HEAD: メインの入力欄から送ると、この回答の続きになります"
                        >
                          HEAD
                        </span>
                      )}
                      {question !== undefined && hasAnswer && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "self-end text-muted-foreground",
                            summary !== undefined &&
                              "h-auto min-w-0 flex-1 justify-start whitespace-normal py-1.5 text-left font-normal",
                          )}
                          aria-expanded={open}
                          aria-controls={answerId}
                          onClick={() => setOpen(question.id, !open)}
                        >
                          <ChevronRight
                            aria-hidden
                            className={cn(
                              "transition-transform",
                              open && "rotate-90",
                            )}
                          />
                          {summary !== undefined ? (
                            <>
                              <span className="sr-only">回答を開く: </span>
                              <span className="line-clamp-2 break-words">
                                {summary}
                              </span>
                            </>
                          ) : open ? (
                            "回答を閉じる"
                          ) : (
                            "回答を開く"
                          )}
                        </Button>
                      )}
                    </div>
                    {hasAnswer && (
                      <div id={answerId} hidden={!open}>
                        <div className="flex flex-col gap-4">
                          {answers.map((message, index) =>
                            renderMessage(message, answerStart + index),
                          )}
                        </div>
                      </div>
                    )}
                    {pending.map((data) => (
                      <ApprovalCard
                        key={data.approvalId}
                        approval={data}
                        onRespond={(behavior, reason) =>
                          respond(data.approvalId, behavior, reason)
                        }
                      />
                    ))}
                  </div>
                );
              })}
            {branchFrom !== undefined && (
              <div
                role="status"
                className="flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                  {side
                    ? "この回答の続きとして分岐します。入力欄から送信すると、同じスレッドに新しい会話ができます。"
                    : "この回答の続きとして分岐します。メインの入力欄から送信すると、新しい会話ができます。"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={creatingBranch}
                  onClick={cancelBranch}
                >
                  <X className="size-3.5" />
                  取り消す
                </Button>
              </div>
            )}
            {branchError !== undefined && (
              <p className="text-destructive text-sm" role="alert">
                {branchError}
              </p>
            )}
            {error !== undefined && (
              <p className="text-destructive text-sm" role="alert">
                {error.message}
              </p>
            )}
          </div>
        </div>
        <div className="px-4 pt-2 pb-3">
          {queueState !== undefined && (
            <QueuePanel
              state={queueState}
              onUpdate={(id, text) =>
                queueAction(() => api.queue.update({ id, text }))
              }
              onRemove={(id) => {
                queue.forget(id);
                return queueAction(() => api.queue.remove({ id }));
              }}
              onRelease={(id) => queueAction(() => api.queue.release({ id }))}
              onResume={() =>
                queueAction(() => api.queue.resume({ chatId: chat.id }))
              }
            />
          )}
          {queueError !== undefined && (
            <p
              className="mx-auto mb-2 max-w-3xl text-destructive text-sm"
              role="alert"
            >
              {queueError}
            </p>
          )}
          {quote !== undefined && (
            <div className="mx-auto mb-2 flex max-w-3xl items-start gap-1">
              <QuoteBlock text={quote.text} />
              {(pendingQuote === undefined || onClearQuote !== undefined) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label="引用を外す"
                  onClick={clearQuote}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              )}
            </div>
          )}
          <Composer
            busy={busy}
            pending={creatingBranch}
            messageLabel={side ? "サイドチャットのメッセージ" : "メッセージ"}
            branchSend={
              !side && onOpenSideBranch !== undefined
                ? { blocker: branchSendBlocker, onSubmit: sendToBranch }
                : undefined
            }
            queueing={queueing && branchFrom === undefined}
            toolbar={
              <ModelPicker
                models={models}
                model={settings.model}
                effort={settings.effort}
                disabled={busy}
                onChange={(next) => {
                  pickedSettings.current = true;
                  setSettings(next);
                  chatDefaults.choose(next);
                }}
              />
            }
            onSubmit={submit}
            onQueue={enqueue}
            onStop={onStop}
          />
          <div className="mx-auto mt-1.5 flex max-w-3xl items-center justify-between gap-3 px-2">
            {environment !== undefined ? (
              <EnvironmentPopover environment={environment} cwd={cwd ?? ""} />
            ) : cwd === undefined || cwd === "" ? (
              <span />
            ) : (
              <span
                className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs"
                title={cwd}
              >
                <Folder className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{folderName(cwd)}</span>
              </span>
            )}
            <span className="flex min-w-0 items-center gap-3">
              {showRateLimit && (
                <RateLimitBadge
                  api={api}
                  activity={`${messages.length}:${status}`}
                />
              )}
              <PromptCacheTimer
                messages={messages}
                model={settings.model}
                busy={busy}
              />
              <UsageTotal messages={messages} />
            </span>
          </div>
        </div>
      </div>
    </WikiTermsContext.Provider>
  );
};
