import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSyncState } from "../../chat/session-sync.ts";
import type { ApiClient } from "./orpc.ts";

/**
 * 表示中の会話の Claude Code セッションに、Monet に取り込んでいない質問があるか（#244）。
 * 会話を開いたとき（スレッド・分岐の切り替えを含む）、生成が終わったとき、
 * Monet の画面にフォーカスが戻ったときに確かめる。確かめるのは読み取りだけで、送信はしない。
 * chatId が undefined（サイドチャットなど）なら確かめない。
 */
export const useSessionSync = (
  api: ApiClient,
  chatId: string | undefined,
  /** 生成中・承認待ち。終わったら確かめ直す。 */
  busy: boolean,
) => {
  const [state, setState] = useState<SessionSyncState>();
  const [checking, setChecking] = useState(false);
  /** 古い会話の結果で上書きしないよう、最後に確かめた会話を覚える。 */
  const latest = useRef(chatId);
  latest.current = chatId;

  const check = useCallback(async () => {
    if (chatId === undefined) return;
    setChecking(true);
    try {
      const next = await api.chats.sessionSync({ id: chatId });
      if (latest.current === chatId) setState(next);
    } catch {
      // 確かめられなくても会話は使える
    } finally {
      if (latest.current === chatId) setChecking(false);
    }
  }, [api, chatId]);

  useEffect(() => {
    setState(undefined);
    if (busy) return;
    void check();
  }, [check, busy]);

  useEffect(() => {
    if (chatId === undefined) return;
    const onFocus = () => void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check, chatId]);

  return {
    /** Monet の外で足された質問の数（無い・分からないときは 0）。 */
    unimported: state?.state === "unimported" ? state.prompts : 0,
    checking,
    check,
  };
};
