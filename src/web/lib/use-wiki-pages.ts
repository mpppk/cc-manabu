import { useCallback, useEffect, useState } from "react";
import type { WikiPageDto } from "../../router.ts";
import type { ApiClient } from "./orpc.ts";

const LOAD_ERROR = "Wiki を読み込めませんでした。";

/**
 * タスクの Wiki のページ一覧。サイドバーの一覧とメインのページ表示で共有する。
 * taskId が undefined の間は読み込まない。
 */
export const useWikiPages = (api: ApiClient, taskId: string | undefined) => {
  const [pages, setPages] = useState<WikiPageDto[]>();
  const [loadError, setLoadError] = useState<string>();

  // 開くたび・タスクを移るたびに読み直す
  useEffect(() => {
    if (taskId === undefined) return;
    let active = true;
    setPages(undefined);
    setLoadError(undefined);
    api.wiki.list({ taskId }).then(
      (loaded) => {
        if (active) setPages(loaded);
      },
      () => {
        if (active) setLoadError(LOAD_ERROR);
      },
    );
    return () => {
      active = false;
    };
  }, [api, taskId]);

  const refresh = useCallback(async () => {
    if (taskId === undefined) return;
    try {
      setPages(await api.wiki.list({ taskId }));
      setLoadError(undefined);
    } catch {
      setLoadError(LOAD_ERROR);
    }
  }, [api, taskId]);

  return { pages, loadError, refresh };
};
