/**
 * URL のパスと画面の対応。
 *
 * - `/`: 未所属の会話一覧
 * - `/p/<projectId>`: プロジェクトの会話一覧
 * - `/c/<chatId>`: 会話（一覧はその会話の所属先）
 * - `/p/<projectId>/wiki[/<pageId>]`: プロジェクトの Wiki
 */
export const chatIdFromPath = (pathname: string): string | undefined =>
  /^\/c\/([^/]+)\/?$/.exec(pathname)?.[1];

export const projectIdFromPath = (pathname: string): string | undefined =>
  /^\/p\/([^/]+)\/?$/.exec(pathname)?.[1];

export const pathForChat = (chatId: string | undefined): string =>
  chatId === undefined ? "/" : `/c/${encodeURIComponent(chatId)}`;

export const pathForProject = (projectId: string | null): string =>
  projectId === null ? "/" : `/p/${encodeURIComponent(projectId)}`;

/** `/p/<projectId>/wiki` と `/p/<projectId>/wiki/<pageId>`。 */
export const wikiFromPath = (
  pathname: string,
): { projectId: string; pageId?: string } | undefined => {
  const match = /^\/p\/([^/]+)\/wiki(?:\/([^/]+))?\/?$/.exec(pathname);
  if (match === null) return undefined;
  const [, projectId = "", pageId] = match;
  return pageId === undefined ? { projectId } : { projectId, pageId };
};

export const pathForWiki = (projectId: string, pageId?: string): string =>
  `/p/${encodeURIComponent(projectId)}/wiki${pageId === undefined ? "" : `/${encodeURIComponent(pageId)}`}`;
