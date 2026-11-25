import { useChat } from "@ai-sdk/react";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  ChevronRight,
  FilePlus,
  Folder,
  GitBranch,
  Loader2,
  Pencil,
  RotateCcw,
  TextQuote,
  X,
} from "lucide-react";
import {
  Fragment,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatUIMessage, Effort } from "../../chat/chat-service.ts";
import { type QuoteData, quotesOf } from "../../chat/quote.ts";
import type { ChatDto } from "../../router.ts";
import { citedPageIds, linkWikiCitations } from "../../wiki/citations.ts";
import {
  createTermMatcher,
  type TermEntry,
  type TermMatch,
} from "../../wiki/term-matcher.ts";
import { isPageTerm, normalizeTerm } from "../../wiki/terms.ts";
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
import { ApprovalCard } from "./approval-card.tsx";
import { Composer } from "./composer.tsx";
import { Markdown, type WikiLinks } from "./markdown.tsx";
import { imagePartsOf, MessageImages } from "./message-images.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { PromptCacheTimer } from "./prompt-cache-timer.tsx";
import { QueuePanel, type QueueState } from "./queue-panel.tsx";
import { Reasoning } from "./reasoning.tsx";
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
  /** この応答から分岐する（完了した応答だけ）。 */
  onBranch?: () => void;
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
          Wiki ページの抜粋を参照しました。
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
  if (total.inputTokens + total.outputTokens === 0) {
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

/** 回答の中の選択範囲と、その画面上の位置（ポップアップを出す場所）。 */
type AnswerSelection = {
  messageId: string;
  text: string;
  rect: { top: number; bottom: number; left: number; right: number };
};

/**
 * 回答の中の選択範囲。1 つの完了した回答の中だけを対象にする（#91）。
 * 選択が無い・複数の回答にまたがるときは undefined。スクロールしたら位置を取り直す。
 */
const useAnswerSelection = (
  transcript: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) => {
  const [selection, setSelection] = useState<AnswerSelection>();
  useEffect(() => {
    if (!enabled) {
      setSelection(undefined);
      return;
    }
    const update = () => {
      const current = window.getSelection();
      const text = current?.toString() ?? "";
      if (
        current === null ||
        current.isCollapsed ||
        current.rangeCount === 0 ||
        text.trim() === ""
      ) {
        setSelection(undefined);
        return;
      }
      const answerOf = (node: Node | null) =>
        (node instanceof Element ? node : node?.parentElement)?.closest(
          "[data-assistant-message]",
        );
      const anchor = answerOf(current.anchorNode);
      const focus = answerOf(current.focusNode);
      const messageId = anchor?.getAttribute("data-assistant-message");
      if (
        anchor === undefined ||
        anchor === null ||
        anchor !== focus ||
        !transcript.current?.contains(anchor) ||
        messageId === null ||
        messageId === undefined
      ) {
        setSelection(undefined);
        return;
      }
      const { top, bottom, left, right } = current
        .getRangeAt(0)
        .getBoundingClientRect();
      setSelection({
        messageId,
        text: text.replace(/\n{3,}/g, "\n\n").trim(),
        rect: { top, bottom, left, right },
      });
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [enabled, transcript]);
  return selection;
};

const POPUP_HEIGHT = 36;
const POPUP_GAP = 8;
const POPUP_WIDTH = 200;

/** 回答の選択範囲のすぐ上（上に余白が無ければ下）に出す操作（#121）。 */
const SelectionPopup = ({
  selection,
  onAsk,
  onCreatePage,
  createPageTitle,
}: {
  selection: AnswerSelection;
  /** 質問する（分岐できる回答だけ）。 */
  onAsk: (() => void) | undefined;
  /** 選んだ語句の Wiki のページを AI で作る（タスクの会話だけ）。 */
  onCreatePage: (() => void) | undefined;
  /** 「ページを作成」の説明（押せない理由を含む）。 */
  createPageTitle: string;
}) => {
  const { rect } = selection;
  const above = rect.top - POPUP_HEIGHT - POPUP_GAP;
  const top = above >= 56 ? above : rect.bottom + POPUP_GAP;
  const center = (rect.left + rect.right) / 2;
  const left = Math.min(
    Math.max(8, center - POPUP_WIDTH / 2),
    window.innerWidth - POPUP_WIDTH - 8,
  );
  // 押したときに選択が外れないようにする
  const keepSelection = {
    onMouseDown: (event: { preventDefault: () => void }) =>
      event.preventDefault(),
    onPointerDown: (event: { preventDefault: () => void }) =>
      event.preventDefault(),
  };
  return (
    <div
      role="toolbar"
      aria-label="選択範囲の操作"
      className="fixed z-40 flex items-center gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ top, left }}
      {...keepSelection}
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={onAsk === undefined}
        title={
          onAsk === undefined
            ? "この回答からは分岐できません"
            : "選んだ部分を引用してサイドチャットで質問します"
        }
        onClick={onAsk}
      >
        <TextQuote className="size-3.5" />
        質問
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={onCreatePage === undefined}
        title={createPageTitle}
        onClick={onCreatePage}
      >
        <FilePlus className="size-3.5" />
        ページを作成
      </Button>
    </div>
  );
};

/** 同じ会話の分岐を切り替えるメニュー（#76）。 */
const BranchSwitcher = ({
  current,
  branches,
  disabled,
  onSelect,
  onOpenSide,
}: {
  current: ChatDto;
  branches: ChatDto[];
  disabled: boolean;
  onSelect: (chatId: string) => void;
  onOpenSide?: (chatId: string) => void;
}) => {
  const sidePicker = useRef<HTMLDetailsElement>(null);
  const sorted = [...branches].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const labelOf = (chat: ChatDto) => {
    const parent = branches.find((b) => b.id === chat.parentId);
    return parent === undefined
      ? branchLabel(chat)
      : `${branchLabel(chat)}（${branchLabel(parent)} から分岐）`;
  };
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <label className="flex items-center gap-2">
        <GitBranch className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">分岐</span>
        <select
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1"
          aria-label="分岐"
          value={current.id}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.value)}
        >
          {sorted.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {labelOf(branch)}
            </option>
          ))}
        </select>
      </label>
      {onOpenSide !== undefined && (
        <details ref={sidePicker} className="group">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md px-1 py-1 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <ChevronRight
              aria-hidden
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            サイドで開く
          </summary>
          <ul
            aria-label="サイドで開く分岐"
            className="max-h-48 overflow-y-auto rounded-md border bg-background p-1"
          >
            {sorted
              .filter((branch) => branch.id !== current.id)
              .map((branch) => (
                <li key={branch.id}>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-auto w-full justify-start whitespace-normal py-1.5 text-left"
                    onClick={() => {
                      if (sidePicker.current !== null) {
                        sidePicker.current.open = false;
                        sidePicker.current.querySelector("summary")?.focus();
                      }
                      onOpenSide(branch.id);
                    }}
                  >
                    {labelOf(branch)}
                  </Button>
                </li>
              ))}
          </ul>
        </details>
      )}
      <span className="text-muted-foreground text-xs">
        会話の履歴は分岐ごとに分かれますが、ファイルへの変更はすべての分岐で共有されます。
      </span>
    </div>
  );
};

/** 分岐元から引き継いだ履歴と、分岐で書いた履歴の境目。 */
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
 * 分岐の予約（#102）。予約はサーバが送るので、送られたら（予約が消えた・サーバで生成中になった）
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
  /** 同じ会話の分岐（#76）。2 つ以上あれば切り替えメニューを出す。 */
  branches?: ChatDto[];
  /** 分岐を開く（作った分岐を開くのにも使う）。 */
  onSelectBranch?: (chatId: string) => void;
  /** メインで開いている分岐を保ったまま、別の分岐をサイドで開く。 */
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
  onAskSelection?: (quote: QuoteData, settings: SendSettings) => void;
  /** 作業フォルダ（入力欄の下に出す）。 */
  cwd?: string;
};

/** 1 つの分岐を表示し、その分岐 ID で送信・再接続する。 */
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
  cwd,
}: ChatViewProps) => {
  const [settings, setSettings] = useState<{
    model: string;
    effort: Effort | null;
  }>({ model: chat.model, effort: (chat.effort as Effort | null) ?? null });
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

  /** 「ここから分岐」で選んだ応答。送信すると分岐を作る。取り消すと元に戻る。 */
  const [branchFrom, setBranchFrom] = useState<string>();
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [branchError, setBranchError] = useState<string>();
  const transcript = useRef<HTMLDivElement>(null);
  const selection = useAnswerSelection(
    transcript,
    onAskSelection !== undefined || onWikiPageCreated !== undefined,
  );
  const cancelBranch = () => {
    setBranchFrom(undefined);
    setBranchError(undefined);
  };
  const selectedTurn =
    selection === undefined
      ? undefined
      : turns.find((turn) =>
          turn.answers.some((m) => m.id === selection.messageId),
        );
  const selectedAnswer =
    (!busy || selection?.messageId !== messages.at(-1)?.id) &&
    (selectedTurn?.question === undefined || isOpen(selectedTurn.question.id))
      ? selectedTurn?.answers.find((m) => m.id === selection?.messageId)
      : undefined;
  const askSelection =
    selection !== undefined &&
    onAskSelection !== undefined &&
    selectedAnswer?.metadata?.claudeCode?.lastAssistantUuid !== undefined
      ? () => {
          onAskSelection(
            {
              text: selection.text,
              sourceMessageId: selection.messageId,
            },
            settingsRef.current,
          );
          window.getSelection()?.removeAllRanges();
        }
      : undefined;
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
          text: `「${page.title}」のページはすでにあります。`,
        });
      }
    } catch {
      setTermNotice({
        messageId,
        tone: "error",
        text: `「${term}」のページを作成できませんでした。もう一度お試しください。`,
      });
    } finally {
      setGeneratingTerms((current) => current.filter((t) => t !== term));
    }
  };
  const selectedTerm = selection?.text.trim();
  const createPageBlocker =
    taskId === null || onWikiPageCreated === undefined
      ? "タスクの会話でだけ、Wiki のページを作れます"
      : selectedTerm === undefined || !isPageTerm(selectedTerm)
        ? "1 行・2〜40 文字の語句を選ぶと、Wiki のページを作れます"
        : generatingTerms.some(
              (term) => normalizeTerm(term) === normalizeTerm(selectedTerm),
            )
          ? "この語句のページを作成しています"
          : undefined;
  const createPageFromSelection =
    selection !== undefined &&
    selectedTerm !== undefined &&
    createPageBlocker === undefined
      ? () => {
          void generatePage(selection.messageId, selectedTerm);
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
        error instanceof Error ? error.message : "分岐を作れませんでした。",
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

  const enqueue = (text: string, images: ImageAttachment[]) => {
    requestNotificationPermission();
    const parts = [
      ...imageFileParts(images),
      ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ];
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
    const files = imageFileParts(images);
    if (branchFrom !== undefined) {
      return createBranch(branchFrom, [
        ...files,
        ...(text === "" ? [] : [{ type: "text" as const, text }]),
      ]);
    }
    void sendMessage(text === "" ? { files } : { text, files }).then(() =>
      onActivity?.(),
    );
    // タイトルと状態（生成中）をすぐ一覧に反映する
    setTimeout(() => onActivity?.(), 300);
  };

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

  return (
    <WikiTermsContext.Provider value={wikiTerms}>
      {selection !== undefined && selectedAnswer !== undefined && (
        <SelectionPopup
          selection={selection}
          onAsk={askSelection}
          onCreatePage={createPageFromSelection}
          createPageTitle={
            createPageBlocker ??
            "選んだ語句の Wiki のページを AI で作ります（画面は移りません）"
          }
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={transcript} className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
            {!side && branches.length > 1 && (
              <BranchSwitcher
                current={chat}
                branches={branches}
                disabled={branchFrom !== undefined}
                onSelect={(id) => onSelectBranch?.(id)}
                {...(onOpenSideBranch === undefined
                  ? {}
                  : { onOpenSide: onOpenSideBranch })}
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
                          title="メインの次のメッセージの起点"
                        >
                          現在地
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
                  この応答の続きとして分岐を作ります。メインの入力欄から送信すると分岐ができます。
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
          <Composer
            busy={busy}
            pending={creatingBranch}
            messageLabel={side ? "サイドチャットのメッセージ" : "メッセージ"}
            queueing={queueing && branchFrom === undefined}
            toolbar={
              <ModelPicker
                models={models}
                model={settings.model}
                effort={settings.effort}
                disabled={busy}
                onChange={setSettings}
              />
            }
            onSubmit={submit}
            onQueue={enqueue}
            onStop={onStop}
          />
          <div className="mx-auto mt-1.5 flex max-w-3xl items-center justify-between gap-3 px-2">
            {cwd === undefined || cwd === "" ? (
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
