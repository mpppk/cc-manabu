import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/utils.ts";
import { Button } from "./button.tsx";

export type DropdownMenuItem = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  variant?: "default" | "destructive";
  /** 直前に区切り線を入れる。 */
  separatorBefore?: boolean;
  /** 押せないとき。title に理由を書く。 */
  disabled?: boolean;
  /** 項目の説明（押せない理由など）。 */
  title?: string;
  /** 右端に出すショートカット（例: ⌘Enter）。 */
  shortcut?: string;
};

/** アイコンボタンから開くメニュー（WAI-ARIA の menu button パターン）。 */
export const DropdownMenu = ({
  label,
  icon,
  items,
  triggerClassName = "size-8",
  placement = "below",
  disabled = false,
}: {
  /** ボタンの名前（aria-label / title）。 */
  label: string;
  icon: ReactNode;
  items: DropdownMenuItem[];
  triggerClassName?: string;
  /** メニューをボタンの下・上のどちらに開くか。 */
  placement?: "below" | "above";
  disabled?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusItem = (index: number) => {
    const count = items.length;
    itemRefs.current[((index % count) + count) % count]?.focus();
  };

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    // メニューの外を押したら閉じる
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent) => {
    const current = itemRefs.current.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(current + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(current - 1);
        break;
      case "Home":
        event.preventDefault();
        focusItem(0);
        break;
      case "End":
        event.preventDefault();
        focusItem(items.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        className={triggerClassName}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon}
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          className={cn(
            "absolute right-0 z-50 flex min-w-44 flex-col rounded-md border bg-background p-1 shadow-md",
            placement === "above" ? "bottom-full mb-1" : "top-full mt-1",
          )}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <Fragment key={item.label}>
              {item.separatorBefore && (
                <hr className="-mx-1 my-1 h-px border-0 bg-border" />
              )}
              <button
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={item.disabled === true ? true : undefined}
                title={item.title}
                className={cn(
                  "flex items-center gap-2 whitespace-nowrap rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus:bg-accent [&_svg]:size-4 [&_svg]:shrink-0",
                  item.variant === "destructive" && "text-destructive",
                  item.disabled === true &&
                    "cursor-not-allowed text-muted-foreground hover:bg-transparent",
                )}
                onClick={() => {
                  // 押せない項目は、理由（title）を読めるようにフォーカスだけ受ける
                  if (item.disabled === true) return;
                  // 開いたダイアログが閉じたとき、フォーカスがボタンに戻るようにする
                  close(true);
                  item.onSelect();
                }}
              >
                {item.icon}
                {item.label}
                {item.shortcut !== undefined && (
                  <kbd className="ml-auto pl-4 font-sans text-muted-foreground text-xs">
                    {item.shortcut}
                  </kbd>
                )}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
};
