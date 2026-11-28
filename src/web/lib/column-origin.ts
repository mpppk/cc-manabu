/**
 * カラムを開いた起点（#267）。用語のリンク・ボタン（element）、選択範囲（range）、
 * 回答本文の紫の破線（sideQuote。メインのチャットが自分で引く）のどれか。
 * 対応するカラムが開いている間、元のカラムの中で起点を強調する。
 */
export type ColumnOrigin =
  | { kind: "element"; element: HTMLElement }
  | { kind: "range"; range: Range }
  | { kind: "sideQuote"; chatId: string };

/** 起点の色の数（カラムの番号ごとに順に使う）。styles.css の --column-origin-* と合わせる。 */
export const ORIGIN_COLORS = 6;

/** 表示している経路での位置（0 がメインのすぐ右）から、起点の色の番号（1 始まり）。 */
export const originColorOf = (position: number): number =>
  (position % ORIGIN_COLORS) + 1;

/**
 * 起点として強調する要素。用語のように、押したボタンを含む入れ物（`data-origin-anchor`）があれば
 * その入れ物にする（要約のカードの中のボタンから開いても、本文の用語を強調する）。
 */
const anchorOf = (element: Element): HTMLElement | undefined => {
  const anchor =
    element.closest<HTMLElement>("[data-origin-anchor]") ??
    element.closest<HTMLElement>(
      "button, a, [role='button'], [role='menuitem']",
    );
  // カラムの外（画面上部のヘッダーなど）は起点にしない
  return anchor?.closest("[data-column]") == null ? undefined : anchor;
};

/** 直前に押した要素（クリックではフォーカスが移らないブラウザ向け）。 */
let lastPointer: { element: Element; at: number } | undefined;
let tracking = false;
const POINTER_MS = 1000;

/** 押した要素を覚え始める（何度呼んでもよい）。 */
export const trackPointer = () => {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target instanceof Element) {
        lastPointer = { element: event.target, at: Date.now() };
      }
    },
    true,
  );
};

/**
 * 今の操作の起点。カラムの中の選択範囲があればそれを、無ければフォーカスのある要素か、
 * 直前に押した要素を起点にする。分からなければ undefined。
 */
export const captureOrigin = (): ColumnOrigin | undefined => {
  if (typeof document === "undefined") return undefined;
  const selection = window.getSelection();
  if (
    selection !== null &&
    selection.rangeCount > 0 &&
    !selection.isCollapsed
  ) {
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node instanceof Element ? node : node.parentElement;
    if (element?.closest("[data-column]") != null) {
      return { kind: "range", range: range.cloneRange() };
    }
  }
  const active = document.activeElement;
  const focused =
    active instanceof HTMLElement && active !== document.body
      ? anchorOf(active)
      : undefined;
  if (focused !== undefined) return { kind: "element", element: focused };
  if (lastPointer !== undefined && Date.now() - lastPointer.at < POINTER_MS) {
    const pointed = anchorOf(lastPointer.element);
    if (pointed !== undefined) return { kind: "element", element: pointed };
  }
  return undefined;
};

/** 選択範囲の起点を引く CSS Custom Highlight API の名前（色ごと。styles.css と合わせる）。 */
export const rangeHighlightName = (color: number) =>
  `monet-origin-range-${color}`;
/** 紫の破線の起点を引く名前（メインのチャットが引く）。 */
export const quoteHighlightName = (color: number) =>
  `monet-origin-quote-${color}`;

/**
 * 起点を強調する。要素には data-column-origin（番号）と色を付け、選択範囲はハイライトで引く。
 * 返した関数で外す。
 */
export const paintOrigins = (
  origins: readonly {
    origin: ColumnOrigin;
    /** カラムの番号（1 始まり。起点に添えて、どのカラムかを見分ける）。 */
    number: number;
    color: number;
  }[],
): (() => void) => {
  const painted: HTMLElement[] = [];
  const ranges = new Map<number, Range[]>();
  for (const { origin, number, color } of origins) {
    if (origin.kind === "element") {
      if (!origin.element.isConnected) continue;
      origin.element.dataset.columnOrigin = String(number);
      origin.element.dataset.columnOriginColor = String(color);
      painted.push(origin.element);
    } else if (origin.kind === "range") {
      if (origin.range.collapsed) continue;
      ranges.set(color, [...(ranges.get(color) ?? []), origin.range]);
    }
  }
  const highlights = typeof CSS !== "undefined" && "highlights" in CSS;
  if (highlights) {
    for (const [color, list] of ranges) {
      CSS.highlights.set(rangeHighlightName(color), new Highlight(...list));
    }
  }
  return () => {
    for (const element of painted) {
      delete element.dataset.columnOrigin;
      delete element.dataset.columnOriginColor;
    }
    if (highlights) {
      for (const color of ranges.keys()) {
        CSS.highlights.delete(rangeHighlightName(color));
      }
    }
  };
};
