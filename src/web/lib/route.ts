/**
 * URL のパスと画面の対応。
 *
 * - `/`: 未所属のスレッド一覧
 * - `/t/<taskId>`: タスクのスレッド一覧
 * - `/c/<chatId>`: 会話（一覧はそのスレッドの所属先）
 * - `/t/<taskId>/wiki[/<pageId>]`: タスクの Wiki
 * - `/tasks`: タスク一覧（`?status=` で絞り込み）
 * - `/tasks/archived`: アーカイブしたタスクの一覧（#241）
 *
 * 「プロジェクト」だったころの `/p/...` と `/projects` も読めるようにする（古いリンク用）。
 */
export const chatIdFromPath = (pathname: string): string | undefined =>
  /^\/c\/([^/]+)\/?$/.exec(pathname)?.[1];

export const taskIdFromPath = (pathname: string): string | undefined =>
  /^\/[tp]\/([^/]+)\/?$/.exec(pathname)?.[1];

export const pathForChat = (chatId: string | undefined): string =>
  chatId === undefined ? "/" : `/c/${encodeURIComponent(chatId)}`;

export const pathForTask = (taskId: string | null): string =>
  taskId === null ? "/" : `/t/${encodeURIComponent(taskId)}`;

/** `/t/<taskId>/wiki` と `/t/<taskId>/wiki/<pageId>`。 */
export const wikiFromPath = (
  pathname: string,
): { taskId: string; pageId?: string } | undefined => {
  const match = /^\/[tp]\/([^/]+)\/wiki(?:\/([^/]+))?\/?$/.exec(pathname);
  if (match === null) return undefined;
  const [, taskId = "", pageId] = match;
  return pageId === undefined ? { taskId } : { taskId, pageId };
};

export const pathForWiki = (taskId: string, pageId?: string): string =>
  `/t/${encodeURIComponent(taskId)}/wiki${pageId === undefined ? "" : `/${encodeURIComponent(pageId)}`}`;

export const TASK_LIST_PATH = "/tasks";

export const isTaskListPath = (pathname: string): boolean =>
  /^\/(tasks|projects)\/?$/.test(pathname);

export const ARCHIVED_TASK_LIST_PATH = "/tasks/archived";

export const isArchivedTaskListPath = (pathname: string): boolean =>
  /^\/tasks\/archived\/?$/.test(pathname);
