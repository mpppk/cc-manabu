/**
 * 入力欄を開いたまま表示する会話（#272）。会話は読むために開くことが多いので、入力欄はふだん閉じておく。
 * ただし、利用者が送信して作った・続けた会話（分岐して送った先、サイドチャットで質問した先など）は、
 * 続けて書けるよう入力欄を開いたまま表示する。再読み込みで忘れる。
 */
const composing = new Set<string>();

/** 送信した会話を覚える（次に表示したときも入力欄を開いておく）。 */
export const markComposing = (chatId: string) => {
  composing.add(chatId);
};

/** 入力欄を開いた状態で表示するか。まだメッセージが無い会話は、書くために開いたものとみなす。 */
export const composerInitiallyOpen = (
  chatId: string,
  messageCount: number,
): boolean => messageCount === 0 || composing.has(chatId);
