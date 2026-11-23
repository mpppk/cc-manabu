/** URL のパス（/c/<id>）と選択中の会話 ID を相互に変換する。 */
export const chatIdFromPath = (pathname: string): string | undefined =>
  /^\/c\/([^/]+)\/?$/.exec(pathname)?.[1];

export const pathForChat = (chatId: string | undefined): string =>
  chatId === undefined ? "/" : `/c/${encodeURIComponent(chatId)}`;
