import { ChevronDown, GitBranch, Loader2, PanelRight } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { ChatDto } from "../../router.ts";
import { branchLabel } from "../lib/groups.ts";
import { cn } from "../lib/utils.ts";
import { ChatStatusBadge } from "./chat-status-badge.tsx";
import { Button } from "./ui/button.tsx";

/** 一覧の各行の、会話を開くボタン。 */
const rowButtons = (list: HTMLUListElement | null): HTMLButtonElement[] => [
  ...(list?.querySelectorAll<HTMLButtonElement>("button[data-branch-row]") ??
    []),
];

/** 会話の名前。分岐した会話には分岐元を添える（読み上げと、一覧の行の名前に使う）。 */
const fullLabelOf = (chat: ChatDto, branches: readonly ChatDto[]): string => {
  const parent = branches.find((b) => b.id === chat.parentId);
  return parent === undefined
    ? branchLabel(chat)
    : `${branchLabel(chat)}（${branchLabel(parent)} から分岐）`;
};

const byCreatedAt = (a: ChatDto, b: ChatDto) =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

/**
 * 会話の一覧を出すポップアップ（ヘッダーの会話の切り替えと、分岐点の回答の下で共有する）。
 * 各行で会話を開くか、サイドで開くかを選べ、会話の状態（回答中・承認待ち・エラー・新しい回答）も出す。
 */
const BranchPopover = ({
  trigger: renderTrigger,
  label,
  listLabel,
  chats,
  branches,
  current,
  unread,
  disabled,
  note,
  footer,
  align,
  onSelect,
  onOpenSide,
}: {
  /** ポップアップを開くボタン。 */
  trigger: (props: {
    ref: RefObject<HTMLButtonElement | null>;
    open: boolean;
    popupId: string;
    toggle: () => void;
  }) => ReactNode;
  /** ポップアップの名前。 */
  label: string;
  listLabel: string;
  /** 一覧に出す会話。 */
  chats: readonly ChatDto[];
  /** 同じスレッドの会話（分岐元の名前を引く）。 */
  branches: readonly ChatDto[];
  /** 開いている会話（一覧にあれば印を付け、開くとその行に移る）。 */
  current: ChatDto;
  unread: ReadonlySet<string>;
  /** HEAD を前の回答に移している間は切り替えない（状態は見られ、サイドでは開ける）。 */
  disabled: boolean;
  note?: ReactNode;
  footer?: ReactNode;
  align: "left" | "right";
  onSelect: (chatId: string) => void;
  onOpenSide?: ((chatId: string) => void) | undefined;
}) => {
  const [open, setOpen] = useState(false);
  const popupId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // 開いている会話の行（無ければ先頭の行）に移る
    const buttons = rowButtons(list.current);
    (
      buttons.find(
        (button) => button.getAttribute("aria-current") === "true",
      ) ?? buttons.find((button) => !button.disabled)
    )?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = rowButtons(list.current);
    if (buttons.length === 0) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next =
      index < 0 ? 0 : (index + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div ref={root} className="relative min-w-0">
      {renderTrigger({
        ref: trigger,
        open,
        popupId,
        toggle: () => setOpen((prev) => !prev),
      })}
      {open && (
        <div
          id={popupId}
          role="dialog"
          aria-label={label}
          className={cn(
            "absolute top-full z-40 mt-1 flex w-80 max-w-[calc(100vw-1rem)] flex-col gap-1 rounded-md border bg-background p-1 text-sm shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
          onKeyDown={onKeyDown}
        >
          {note}
          {disabled && (
            <p className="px-2 pt-1 text-muted-foreground text-xs">
              HEAD
              を前の回答に移している間は、会話を切り替えられません（サイドでは開けます）。
            </p>
          )}
          <ul
            ref={list}
            aria-label={listLabel}
            className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto"
          >
            {[...chats].sort(byCreatedAt).map((chat) => {
              const parent = branches.find((b) => b.id === chat.parentId);
              const selected = chat.id === current.id;
              return (
                <li
                  key={chat.id}
                  className={cn(
                    "flex items-center gap-1 rounded-md pr-1",
                    selected && "bg-muted",
                  )}
                >
                  <button
                    type="button"
                    data-branch-row
                    aria-label={fullLabelOf(chat, branches)}
                    className="flex min-w-0 flex-1 flex-col items-start rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    aria-current={selected ? "true" : undefined}
                    disabled={disabled && !selected}
                    onClick={() => {
                      close(true);
                      if (!selected) onSelect(chat.id);
                    }}
                  >
                    <span
                      className={cn(
                        "w-full truncate",
                        selected && "font-medium",
                      )}
                    >
                      {branchLabel(chat)}
                    </span>
                    {parent !== undefined && (
                      <span className="w-full truncate text-muted-foreground text-xs">
                        {branchLabel(parent)} から分岐
                      </span>
                    )}
                  </button>
                  <ChatStatusBadge
                    status={chat.status}
                    unread={unread.has(chat.id)}
                  />
                  {onOpenSide !== undefined && !selected && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 text-muted-foreground"
                      aria-label={`「${branchLabel(chat)}」をサイドで開く`}
                      title="メインはそのままで、サイドで開く"
                      onClick={() => {
                        close(false);
                        onOpenSide(chat.id);
                      }}
                    >
                      <PanelRight className="size-3.5" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {footer}
        </div>
      )}
    </div>
  );
};

/** ほかの会話の状況（ヘッダーのボタンに出す）。 */
const summaryOf = (
  others: readonly ChatDto[],
  unread: ReadonlySet<string>,
) => ({
  running: others.filter((chat) => chat.status === "running").length,
  approval: others.filter((chat) => chat.status === "awaiting_approval").length,
  error: others.filter((chat) => chat.status === "error").length,
  unread: others.filter((chat) => chat.status === "idle" && unread.has(chat.id))
    .length,
});

type MenuProps = {
  current: ChatDto;
  /** 同じスレッドの会話（current を含む）。 */
  branches: readonly ChatDto[];
  /** 新しい回答の印が付いた会話。 */
  unread: ReadonlySet<string>;
  /** HEAD を前の回答に移している間は切り替えない（状態は見られ、サイドでは開ける）。 */
  disabled: boolean;
  onSelect: (chatId: string) => void;
  onOpenSide?: ((chatId: string) => void) | undefined;
};

/**
 * 同じスレッドの会話を切り替えるメニュー（#76）。画面上部のヘッダーに出し、
 * どこまでスクロールしていても切り替えられるようにする（#234）。
 * 各会話の状態（回答中・承認待ち・エラー・新しい回答）も出す。
 */
export const BranchMenu = (props: MenuProps) => {
  const { current, branches, unread } = props;
  const summary = summaryOf(
    branches.filter((chat) => chat.id !== current.id),
    unread,
  );
  const label = branchLabel(current);
  return (
    <BranchPopover
      {...props}
      chats={branches}
      label="会話"
      listLabel="スレッドの会話"
      align="right"
      footer={
        <p className="border-t px-2 pt-1.5 pb-1 text-muted-foreground text-xs">
          履歴は会話ごとに分かれますが、ファイルへの変更はスレッド内のすべての会話で共有されます。
        </p>
      }
      trigger={({ ref, open, popupId, toggle }) => (
        <Button
          ref={ref}
          type="button"
          variant="outline"
          size="sm"
          className="max-w-[min(28rem,50vw)] gap-1.5 px-2"
          aria-label="会話を切り替える"
          title={`会話: ${label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popupId : undefined}
          onClick={toggle}
        >
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate" data-testid="current-branch">
            {label}
          </span>
          {summary.approval > 0 && (
            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
              承認待ち {summary.approval}
            </span>
          )}
          {summary.running > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
              <Loader2 aria-hidden className="size-3 animate-spin" />
              回答中 {summary.running}
            </span>
          )}
          {summary.error > 0 && (
            <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
              エラー {summary.error}
            </span>
          )}
          {summary.unread > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-[10px] text-sky-700 dark:text-sky-400">
              <span aria-hidden className="size-2 rounded-full bg-sky-500" />
              新しい回答 {summary.unread}
            </span>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      )}
    />
  );
};

/**
 * 分岐点の回答の下に出す、その回答から分岐した会話（#235）。
 * どこで分かれたかを見ながら、その会話を開くか、サイドで開ける。
 */
export const ForkPointBranches = ({
  forks,
  quoted = false,
  ...props
}: MenuProps & {
  /** この回答から分岐した会話。 */
  forks: readonly ChatDto[];
  /** 回答の一部を引用して質問した会話があるか（本文に下線を引く。#239）。 */
  quoted?: boolean;
}) => {
  const active = forks.some(
    (chat) => chat.status === "running" || chat.status === "awaiting_approval",
  );
  const unread = forks.some(
    (chat) => chat.status === "idle" && props.unread.has(chat.id),
  );
  return (
    <BranchPopover
      {...props}
      chats={forks}
      label="この回答から分岐した会話"
      listLabel="この回答から分岐した会話"
      align="left"
      {...(quoted
        ? {
            note: (
              <p className="flex items-center gap-1.5 px-2 pt-1 text-muted-foreground text-xs">
                <span
                  aria-hidden
                  className="w-5 shrink-0 border-violet-500 border-b-2 border-dashed dark:border-violet-400"
                />
                本文の紫の破線は、サイドで質問した箇所です。押すとその会話を開きます。
              </p>
            ),
          }
        : {})}
      trigger={({ ref, open, popupId, toggle }) => (
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-muted-foreground text-xs"
          title="この回答から分岐した会話を開く"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popupId : undefined}
          onClick={toggle}
        >
          <GitBranch className="size-3.5" />
          この回答から分岐 {forks.length}
          {active && (
            <Loader2
              className="size-3 animate-spin"
              aria-label="回答中の会話があります"
            />
          )}
          {!active && unread && (
            <span
              className="size-2 rounded-full bg-sky-500"
              role="img"
              aria-label="新しい回答があります"
            />
          )}
        </Button>
      )}
    />
  );
};
