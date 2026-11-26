import { FilePlus, TextQuote } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
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

/** 選択範囲のすぐ上（上に余白が無ければ下）に出す操作（#121）。 */
export const SelectionPopup = ({
  selection,
  ask,
  createPage,
}: {
  selection: TextSelection;
  /** 選んだ部分を引用して質問する。 */
  ask: SelectionAction;
  /** 選んだ語句の Wiki のページを AI で作る。 */
  createPage: SelectionAction;
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
        disabled={ask.onClick === undefined}
        title={ask.title}
        onClick={ask.onClick}
      >
        <TextQuote className="size-3.5" />
        質問
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
        ページを作成
      </Button>
    </div>
  );
};
