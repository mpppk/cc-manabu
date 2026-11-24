import { useCallback, useEffect, useState } from "react";
import type { WikiPageDto } from "../../router.ts";
import type { ApiClient } from "./orpc.ts";

const LOAD_ERROR = "Wiki を読み込めませんでした。";

/**
 * プロジェクトの Wiki のページ一覧。サイドバーの一覧とメインのページ表示で共有する。
 * projectId が undefined の間は読み込まない。
 */
export const useWikiPages = (api: ApiClient, projectId: string | undefined) => {
  const [pages, setPages] = useState<WikiPageDto[]>();
  const [loadError, setLoadError] = useState<string>();

  // 開くたび・プロジェクトを移るたびに読み直す
  useEffect(() => {
    if (projectId === undefined) return;
    let active = true;
    setPages(undefined);
    setLoadError(undefined);
    api.wiki.list({ projectId }).then(
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
  }, [api, projectId]);

  const refresh = useCallback(async () => {
    if (projectId === undefined) return;
    try {
      setPages(await api.wiki.list({ projectId }));
      setLoadError(undefined);
    } catch {
      setLoadError(LOAD_ERROR);
    }
  }, [api, projectId]);

  return { pages, loadError, refresh };
};
