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
};

/** アイコンボタンから開くメニュー（WAI-ARIA の menu button パターン）。 */
export const DropdownMenu = ({
  label,
  icon,
  items,
  triggerClassName = "size-8",
}: {
  /** ボタンの名前（aria-label / title）。 */
  label: string;
  icon: ReactNode;
  items: DropdownMenuItem[];
  triggerClassName?: string;
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
          className="absolute top-full right-0 z-50 mt-1 flex min-w-44 flex-col rounded-md border bg-background p-1 shadow-md"
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
                className={cn(
                  "flex items-center gap-2 whitespace-nowrap rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus:bg-accent [&_svg]:size-4 [&_svg]:shrink-0",
                  item.variant === "destructive" && "text-destructive",
                )}
                onClick={() => {
                  // 開いたダイアログが閉じたとき、フォーカスがボタンに戻るようにする
                  close(true);
                  item.onSelect();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
};
