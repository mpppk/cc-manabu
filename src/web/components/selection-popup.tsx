import { ChevronDown, FilePlus, TextQuote } from "lucide-react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui/button.tsx";

/** 選択範囲と、その画面上の位置（ポップアップを出す場所）。 */
export type TextSelection = {
  /** 選択範囲を含む要素の、attribute の値（回答のメッセージ id・Wiki ページの id）。 */
  sourceId: string;
  text: string;
  rect: { top: number; bottom: number; left: number; right: number };
};

/**
 * container の中で、attribute を持つ 1 つの要素の中だけを対象にした選択範囲（#91）。
 * 選択が無い・複数の要素にまたがるときは undefined。スクロールしたら位置を取り直す。
 */
export const useTextSelection = (
  container: RefObject<HTMLElement | null>,
  attribute: string,
  enabled: boolean,
) => {
  const [selection, setSelection] = useState<TextSelection>();
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
      const sourceOf = (node: Node | null) =>
        (node instanceof Element ? node : node?.parentElement)?.closest(
          `[${attribute}]`,
        );
      const anchor = sourceOf(current.anchorNode);
      const focus = sourceOf(current.focusNode);
      const sourceId = anchor?.getAttribute(attribute);
      if (
        anchor === undefined ||
        anchor === null ||
        anchor !== focus ||
        !container.current?.contains(anchor) ||
        sourceId === null ||
        sourceId === undefined
      ) {
        setSelection(undefined);
        return;
      }
      const { top, bottom, left, right } = current
        .getRangeAt(0)
        .getBoundingClientRect();
      setSelection({
        sourceId,
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
  }, [enabled, container, attribute]);
  return selection;
};

const POPUP_HEIGHT = 36;
const POPUP_GAP = 8;
const POPUP_WIDTH = 200;

/** ポップアップのボタン。onClick が無ければ押せない（title に理由を書く）。 */
export type SelectionAction = {
  onClick: (() => void) | undefined;
  title: string;
};

/** 「質問」で選ぶ、引用を添えて続ける先（#222）。 */
export type AskChoice = SelectionAction & { label: string };

/**
 * 選択範囲のすぐ上（上に余白が無ければ下）に出す操作（#121）。
 * askChoices があれば、「質問」を押すと続ける先のメニューを開く（#222）。
 */
export const SelectionPopup = ({
  selection,
  ask,
  askChoices,
  createPage,
}: {
  selection: TextSelection;
  /** 選んだ部分を引用して質問する。askChoices があるときは、押せるかどうかと説明だけを使う。 */
  ask: SelectionAction;
  /** 「質問」から選ぶ、引用を添えて続ける先。 */
  askChoices?: readonly AskChoice[] | undefined;
  /** 選んだ語句の Wiki のページを AI で作る。 */
  createPage: SelectionAction;
}) => {
  const [choosing, setChoosing] = useState(false);
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  // 選択範囲が変わったら、メニューを閉じる
  const selectionKey = `${selection.sourceId}:${selection.text}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 選択範囲が変わったら閉じる
  useEffect(() => setChoosing(false), [selectionKey]);
  useEffect(() => {
    if (choosing) {
      menu.current?.querySelector<HTMLButtonElement>("button:enabled")?.focus();
    }
  }, [choosing]);
  const hasChoices = askChoices !== undefined && askChoices.length > 0;
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
        disabled={
          hasChoices
            ? ask.onClick === undefined &&
              !askChoices.some((c) => c.onClick !== undefined)
            : ask.onClick === undefined
        }
        title={ask.title}
        {...(hasChoices
          ? {
              "aria-haspopup": "menu" as const,
              "aria-expanded": choosing,
              "aria-controls": choosing ? menuId : undefined,
              onClick: () => setChoosing(!choosing),
            }
          : { onClick: ask.onClick })}
      >
        <TextQuote className="size-3.5" />
        質問
        {hasChoices && <ChevronDown className="size-3" aria-hidden />}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={createPage.onClick === undefined}
        title={createPage.title}
        onClick={createPage.onClick}
      >
        <FilePlus className="size-3.5" />
        ノートを作成
      </Button>
      {hasChoices && choosing && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="引用して続ける先"
          className="absolute top-full left-0 mt-1 flex w-max min-w-full flex-col rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setChoosing(false);
              return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = [
              ...(menu.current?.querySelectorAll<HTMLButtonElement>(
                "button:enabled",
              ) ?? []),
            ];
            const at = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "ArrowDown"
                ? (at + 1) % items.length
                : (at - 1 + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          {askChoices.map((choice) => (
            <button
              key={choice.label}
              type="button"
              role="menuitem"
              className="rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"
              disabled={choice.onClick === undefined}
              title={choice.title}
              onClick={() => {
                setChoosing(false);
                choice.onClick?.();
              }}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
