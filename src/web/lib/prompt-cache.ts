import type { ChatUIMessage } from "../../chat/chat-service.ts";
import type { PromptCacheObservation } from "../../provider/map-stream.ts";

/**
 * プロンプトキャッシュの推定（#103）。
 *
 * - `active`: 期限（エポックミリ秒）が分かる。過ぎていれば期限切れ
 * - `unknown`: キャッシュを観測できない・TTL を決められない（reason に理由）
 * - `none`: まだ回答が無い（何も出さない）
 */
export type PromptCacheEstimate =
  | { state: "active"; expiresAt: number; ttlSeconds: number }
  | { state: "unknown"; reason: string }
  | { state: "none" };

const TTL_5M = 5 * 60;
const TTL_1H = 60 * 60;

type Ttl = number | "mixed" | undefined;

/** 書き込みの内訳から TTL を決める。書き込みが無ければ undefined。 */
const ttlOfWrite = (cache: PromptCacheObservation): Ttl => {
  const has5m = cache.cacheWrite5mTokens > 0;
  const has1h = cache.cacheWrite1hTokens > 0;
  if (has5m && has1h) return "mixed";
  if (has1h) return TTL_1H;
  if (has5m) return TTL_5M;
  return undefined;
};

/**
 * 会話の回答から、プロンプトキャッシュの期限を見積もる。
 *
 * 最後のモデルリクエストの開始時刻に TTL を足す。読み込みだけのリクエストは、
 * それより前に書き込んだときの TTL で延長されたものとみなす。
 * 中断などで観測が無い回答は飛ばす（より古いリクエストを使うので、長めには見積もらない）。
 *
 * @param model 次に送るときのモデル。最後の回答と違えばキャッシュは使えない
 */
export const estimatePromptCache = (
  messages: readonly ChatUIMessage[],
  model: string,
): PromptCacheEstimate => {
  const answers = messages.filter((m) => m.role === "assistant");
  if (answers.length === 0) return { state: "none" };
  const observed = answers.flatMap((m) => {
    const cache = m.metadata?.claudeCode?.promptCache;
    return cache === undefined ? [] : [{ cache, model: m.metadata?.model }];
  });
  const last = observed.at(-1);
  if (last === undefined) {
    return {
      state: "unknown",
      reason: "この会話ではキャッシュの情報を取得できていません。",
    };
  }
  if (last.model !== undefined && last.model !== model) {
    return {
      state: "unknown",
      reason: "モデルを変えたため、次の送信ではキャッシュを使えません。",
    };
  }
  const { cache } = last;
  if (
    cache.cacheReadTokens +
      cache.cacheWrite5mTokens +
      cache.cacheWrite1hTokens ===
    0
  ) {
    return {
      state: "unknown",
      reason: "最後のリクエストではキャッシュが使われていません。",
    };
  }
  let ttl = ttlOfWrite(cache);
  if (ttl === undefined) {
    // 読み込みだけ。前に書き込んだときの TTL で延長されたとみなす
    for (const earlier of observed.slice(0, -1).reverse()) {
      ttl = ttlOfWrite(earlier.cache);
      if (ttl !== undefined) break;
    }
  }
  if (ttl === "mixed") {
    return {
      state: "unknown",
      reason:
        "TTL の異なるキャッシュが混在しているため、残り時間を決められません。",
    };
  }
  if (ttl === undefined) {
    return {
      state: "unknown",
      reason: "キャッシュの TTL を確認できません。",
    };
  }
  return {
    state: "active",
    expiresAt: cache.requestStartedAt + ttl * 1000,
    ttlSeconds: ttl,
  };
};

/** 残り時間を「m:ss」で表す（1 時間以上は「h:mm:ss」）。 */
export const formatRemaining = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};
