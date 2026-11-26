import { Result } from "@praha/byethrow";
import { eq } from "drizzle-orm";
import type { ChatDefaults } from "../chat/chat-defaults.ts";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";
import { appState } from "./schema.ts";

const CHAT_DEFAULTS_KEY = "chat_defaults";

/** アプリ全体の設定。サーバを再起動しても引き継ぐよう app_state に保存する。 */
export const createPreferencesRepository = (db: Db) => ({
  /** 最後に選んだモデルと effort（#164）。まだ選んでいなければ null。 */
  chatDefaults: (): Result.Result<ChatDefaults | null, DatabaseError> =>
    Result.try({
      try: () =>
        (db
          .select()
          .from(appState)
          .where(eq(appState.key, CHAT_DEFAULTS_KEY))
          .get()?.value as ChatDefaults | undefined) ?? null,
      catch: (cause) => new DatabaseError({ cause }),
    }),

  saveChatDefaults: (
    defaults: ChatDefaults,
  ): Result.Result<void, DatabaseError> =>
    Result.try({
      try: () => {
        const updatedAt = new Date();
        const value = { model: defaults.model, effort: defaults.effort };
        db.insert(appState)
          .values({ key: CHAT_DEFAULTS_KEY, value, updatedAt })
          .onConflictDoUpdate({
            target: appState.key,
            set: { value, updatedAt },
          })
          .run();
      },
      catch: (cause) => new DatabaseError({ cause }),
    }),
});

export type PreferencesRepository = ReturnType<
  typeof createPreferencesRepository
>;
