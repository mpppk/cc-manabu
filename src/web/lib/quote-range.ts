/**
 * 回答の中で引用した範囲（#239）。回答の本文（Markdown を描画したテキスト）の中の文字の位置で表す。
 *
 * 本文は、回答の要素の中の `[data-answer-text]`（テキストのパーツ）の文字を順につないだもの。
 * 思考やツールの実行（開閉できる）は含めないので、開け閉めしても位置は変わらない。
 */
import type { QuoteRange } from "../../chat/quote.ts";

const isSpace = (char: string) => /\s/.test(char);

/** 空白を除いた文字列と、その各文字の元の位置。段落の区切りの改行の有無を気にせず比べるため。 */
const compact = (text: string): { chars: string; positions: number[] } => {
  let chars = "";
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (isSpace(char)) continue;
    chars += char;
    positions.push(i);
  }
  return { chars, positions };
};

const sameText = (a: string, b: string) =>
  compact(a).chars === compact(b).chars;

/**
 * 本文の中で、引用した範囲を探す。保存した位置が引用の文字列と合えばそれを使い、
 * 合わなければ（位置の無い古い引用・回答の表示が変わったとき）文字列で探す。
 * 同じ文字列が何度も出てくるときは、保存した位置にいちばん近いものを選ぶ。
 */
export const locateQuote = (
  text: string,
  quote: { text: string; range?: QuoteRange | undefined },
): QuoteRange | undefined => {
  const { range } = quote;
  if (
    range !== undefined &&
    range.start >= 0 &&
    range.start < range.end &&
    range.end <= text.length &&
    sameText(text.slice(range.start, range.end), quote.text)
  ) {
    return range;
  }
  const haystack = compact(text);
  const needle = compact(quote.text).chars;
  if (needle === "") return undefined;
  let best: number | undefined;
  for (
    let index = haystack.chars.indexOf(needle);
    index >= 0;
    index = haystack.chars.indexOf(needle, index + 1)
  ) {
    const start = haystack.positions[index] ?? 0;
    if (
      best === undefined ||
      (range !== undefined &&
        Math.abs(start - range.start) <
          Math.abs((haystack.positions[best] ?? 0) - range.start))
    ) {
      best = index;
    }
    if (range === undefined) break;
  }
  if (best === undefined) return undefined;
  const start = haystack.positions[best];
  const last = haystack.positions[best + needle.length - 1];
  return start === undefined || last === undefined
    ? undefined
    : { start, end: last + 1 };
};

/** 回答の要素の中の、本文のテキストノード（文書の順）。 */
export const answerTextNodes = (root: Element): Text[] => {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (
      node instanceof Text &&
      node.parentElement?.closest("[data-answer-text]") != null
    ) {
      nodes.push(node);
    }
  }
  return nodes;
};

/** 回答の本文。 */
export const answerText = (root: Element): string =>
  answerTextNodes(root)
    .map((node) => node.data)
    .join("");

/** DOM の選択範囲を、本文の中の位置にする。本文にかからなければ undefined。 */
export const rangeToOffsets = (
  root: Element,
  range: Range,
): QuoteRange | undefined => {
  let offset = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const node of answerTextNodes(root)) {
    if (range.intersectsNode(node)) {
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : node.length;
      start ??= offset + from;
      end = offset + to;
    }
    offset += node.length;
  }
  return start === undefined || end === undefined || start >= end
    ? undefined
    : { start, end };
};

/** 本文の中の位置を、DOM の範囲にする。 */
export const offsetsToRange = (
  root: Element,
  { start, end }: QuoteRange,
): Range | undefined => {
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (const node of answerTextNodes(root)) {
    const next = offset + node.length;
    if (!started && start < next) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= next) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset = next;
  }
  return undefined;
};

/** 回答の中で引用した範囲を、DOM の範囲として探す。見つからなければ undefined。 */
export const findQuoteRange = (
  root: Element,
  quote: { text: string; range?: QuoteRange | undefined },
): Range | undefined => {
  const located = locateQuote(answerText(root), quote);
  return located === undefined ? undefined : offsetsToRange(root, located);
};

/** 回答の本文全体（引用した範囲が見つからないときに代わりに示す）。 */
export const wholeAnswerRange = (root: Element): Range | undefined => {
  const nodes = answerTextNodes(root);
  const first = nodes[0];
  const last = nodes.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.length);
  return range;
};
