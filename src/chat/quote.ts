/**
 * 回答の一部を引用した質問（#91）。サーバと Web UI の両方で使うので、ほかに依存しない。
 */

/** 質問の対象として選んだ回答の一部。 */
export type QuoteData = {
  /** 選んだテキスト（改行を含む）。 */
  text: string;
  /** 引用元の回答（分岐元の assistant メッセージ）の id。 */
  sourceMessageId: string;
};

/** ユーザー発話に付いた引用。 */
export const quotesOf = (
  parts: readonly { type: string; data?: unknown }[],
): QuoteData[] =>
  parts.flatMap((part) =>
    part.type === "data-quote" ? [part.data as QuoteData] : [],
  );

/** 引用を、質問とは区別してモデルに渡すテキスト。 */
export const quoteText = (quote: QuoteData): string =>
  [
    "以下は、直前までの回答から利用者が選んだ引用です。続く質問は、この引用部分についてのものです。",
    "<quote>",
    quote.text.replace(/<\/?quote>/gi, ""),
    "</quote>",
  ].join("\n");
