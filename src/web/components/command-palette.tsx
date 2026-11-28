import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { filterCommands, type PaletteCommand } from "../lib/commands.ts";
import { MODIFIER_LABEL } from "../lib/shortcut.ts";
import { cn } from "../lib/utils.ts";

export type CommandItem = PaletteCommand & { icon: ReactNode };

/**
 * コマンドパレット（⌘K / Ctrl+K、#243）。操作名で絞り込み、上下キーで選んで Enter で実行する。
 * 実行するとパレットを閉じてから操作を始める（操作の移したフォーカスを奪わない）。
 * 何もせずに閉じたら、開く前にフォーカスしていた入力欄などに戻る。
 */
export const CommandPalette = ({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly CommandItem[];
}) => {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  /** 閉じたあとに実行する操作。 */
  const pending = useRef<CommandItem | undefined>(undefined);
  /** 開く前にフォーカスしていた要素（何もせずに閉じたら戻す）。 */
  const returnTo = useRef<HTMLElement | null>(null);
  const matched = filterCommands(commands, query);
  const current = matched[Math.min(active, matched.length - 1)];

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
  }, [open]);

  // 選んでいる候補が見えるようにする
  useEffect(() => {
    if (current === undefined) return;
    list.current
      ?.querySelector(`[data-command-id="${current.id}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const run = (command: CommandItem) => {
    pending.current = command;
    onOpenChange(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matched.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const index = current === undefined ? -1 : matched.indexOf(current);
      setActive((index + step + matched.length) % matched.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (current !== undefined) run(current);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[15vh] left-1/2 z-50 flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
          onOpenAutoFocus={() => {
            // 検索欄に移る前に、元の場所を覚えておく
            returnTo.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }}
          onCloseAutoFocus={(event) => {
            // 開くボタンが無いので、Radix の既定（開くボタンに戻す）は使わない
            event.preventDefault();
            const command = pending.current;
            const previous = returnTo.current;
            pending.current = undefined;
            returnTo.current = null;
            if (command === undefined) {
              if (previous?.isConnected === true) previous.focus();
              return;
            }
            // 実行した操作がフォーカスを移すので、開く前の場所には戻さない
            command.run();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            コマンドパレット
          </DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b px-3">
            <Search
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
            <input
              type="text"
              role="combobox"
              aria-label="コマンドを検索"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                current === undefined ? undefined : `${listId}-${current.id}`
              }
              placeholder="操作名を入力（例: タスク）"
              className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
            <kbd className="shrink-0 rounded border px-1.5 text-[10px] text-muted-foreground">
              Esc
            </kbd>
          </div>
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label="コマンド"
            className="flex max-h-80 flex-col gap-0.5 overflow-y-auto p-1"
          >
            {matched.map((command) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: キー操作は検索欄（combobox）で受ける
              <div
                key={command.id}
                tabIndex={-1}
                id={`${listId}-${command.id}`}
                role="option"
                data-command-id={command.id}
                aria-selected={command === current}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm",
                  command === current && "bg-accent text-accent-foreground",
                )}
                onPointerMove={() => setActive(matched.indexOf(command))}
                onClick={() => run(command)}
              >
                <span
                  aria-hidden
                  className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4"
                >
                  {command.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                {command.shortcut !== undefined && (
                  <kbd className="shrink-0 text-muted-foreground text-xs">
                    {command.shortcut}
                  </kbd>
                )}
              </div>
            ))}
          </div>
          {matched.length === 0 && (
            <p
              className="px-3 pb-3 text-muted-foreground text-sm"
              role="status"
            >
              「{query}」に一致する操作はありません。
            </p>
          )}
          <p className="border-t px-3 py-1.5 text-muted-foreground text-xs">
            ↑↓ で選択・Enter で実行・{MODIFIER_LABEL}K で開閉
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};
