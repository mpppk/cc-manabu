import { Result } from "@praha/byethrow";
import { eq } from "drizzle-orm";
import type { RateLimitSnapshot } from "../chat/rate-limit.ts";
import { DatabaseError } from "./chat-repository.ts";
import type { Db } from "./index.ts";
import { appState } from "./schema.ts";

const KEY = "rate_limit";

/** 最後に観測した利用枠（#116）。サーバを再起動しても表示できるよう保存する。 */
export const createRateLimitRepository = (db: Db) => ({
  save: (snapshot: RateLimitSnapshot): Result.Result<void, DatabaseError> =>
    Result.try({
      try: () => {
        const updatedAt = new Date(snapshot.observedAt);
        db.insert(appState)
          .values({ key: KEY, value: snapshot, updatedAt })
          .onConflictDoUpdate({
            target: appState.key,
            set: { value: snapshot, updatedAt },
          })
          .run();
      },
      catch: (cause) => new DatabaseError({ cause }),
    }),

  latest: (): Result.Result<RateLimitSnapshot | null, DatabaseError> =>
    Result.try({
      try: () =>
        (db.select().from(appState).where(eq(appState.key, KEY)).get()?.value as
          | RateLimitSnapshot
          | undefined) ?? null,
      catch: (cause) => new DatabaseError({ cause }),
    }),
});

export type RateLimitRepository = ReturnType<typeof createRateLimitRepository>;
