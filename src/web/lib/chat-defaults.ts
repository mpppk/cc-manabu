import { createContext, useCallback, useEffect, useState } from "react";
import type { ChatDefaults } from "../../chat/chat-defaults.ts";
import type { ApiClient } from "./orpc.ts";

export type ChatDefaultsState = {
  /** 最後に選んだモデルと effort。undefined は読み込み中、null は未設定。 */
  defaults: ChatDefaults | null | undefined;
  /** 利用者がモデルか effort を選び直したときに呼ぶ。自動で選ばれた値では呼ばない。 */
  choose: (next: ChatDefaults) => void;
};

/** 新規スレッドの初期値（#164）。 */
export const ChatDefaultsContext = createContext<ChatDefaultsState>({
  defaults: null,
  choose: () => {},
});

/** 新規スレッドの初期値を読み込み、選び直したら保存する。 */
export const useChatDefaultsState = (api: ApiClient): ChatDefaultsState => {
  const [defaults, setDefaults] = useState<ChatDefaults | null>();
  useEffect(() => {
    let active = true;
    api.preferences.chatDefaults().then(
      (loaded) => {
        // 読み込む前に選んでいたら、そちらを優先する
        if (active) setDefaults((current) => current ?? loaded);
      },
      () => {
        if (active) setDefaults((current) => current ?? null);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);
  const choose = useCallback(
    (next: ChatDefaults) => {
      setDefaults(next);
      // 保存できなくても、この画面の中では選んだ値を使う
      api.preferences.setChatDefaults(next).catch(() => {});
    },
    [api],
  );
  return { defaults, choose };
};
