/**
 * URL のパスと画面の対応。
 *
 * - `/`: 未所属の会話一覧
 * - `/p/<projectId>`: プロジェクトの会話一覧
 * - `/c/<chatId>`: 会話（一覧はその会話の所属先）
 */
export const chatIdFromPath = (pathname: string): string | undefined =>
  /^\/c\/([^/]+)\/?$/.exec(pathname)?.[1];

export const projectIdFromPath = (pathname: string): string | undefined =>
  /^\/p\/([^/]+)\/?$/.exec(pathname)?.[1];

export const pathForChat = (chatId: string | undefined): string =>
  chatId === undefined ? "/" : `/c/${encodeURIComponent(chatId)}`;

export const pathForProject = (projectId: string | null): string =>
  projectId === null ? "/" : `/p/${encodeURIComponent(projectId)}`;
