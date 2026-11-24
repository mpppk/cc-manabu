import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

export type RateLimitStatus = "allowed" | "allowed_warning" | "rejected";

/** 利用枠の 1 つの窓（5 時間・7 日間など）。 */
export type RateLimitWindow = {
  /** five_hour / seven_day / seven_day_opus など。 */
  type: string;
  /** 使った割合（0〜1）。分からなければ null。 */
  utilization: number | null;
  /** リセットされる時刻（エポックミリ秒）。分からなければ null。 */
  resetsAt: number | null;
  status: RateLimitStatus | null;
};

/** 最後に観測した利用枠（#116）。 */
export type RateLimitSnapshot = {
  /** 観測した時刻（エポックミリ秒）。 */
  observedAt: number;
  /** いちばん厳しい枠の状態（rate_limit_event の status）。 */
  status: RateLimitStatus;
  /** status の対象の枠。 */
  rateLimitType: string | null;
  resetsAt: number | null;
  windows: RateLimitWindow[];
};

const STATUSES: readonly string[] = ["allowed", "allowed_warning", "rejected"];

const statusOf = (value: unknown): RateLimitStatus | null =>
  typeof value === "string" && STATUSES.includes(value)
    ? (value as RateLimitStatus)
    : null;

const numberOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** 秒・ミリ秒のどちらで来ても、エポックミリ秒にする。 */
const toMs = (value: unknown): number | null => {
  const n = numberOf(value);
  if (n === null) return null;
  return n < 1e12 ? n * 1000 : n;
};

/**
 * rate_limit_event の情報を、表示に使う形にする。
 *
 * 実機では型に無い `unifiedWindows`（枠ごとの利用率とリセット時刻）も届く（docs/spikes/rate-limits.md）。
 * あればそれを使い、無ければ型にある 1 つの枠だけを使う。
 */
export const normalizeRateLimit = (
  info: SDKRateLimitInfo,
  observedAt: number,
): RateLimitSnapshot => {
  const unified = (info as { unifiedWindows?: unknown }).unifiedWindows;
  const windows: RateLimitWindow[] =
    typeof unified === "object" && unified !== null
      ? Object.entries(unified as Record<string, unknown>).flatMap(
          ([type, value]) => {
            if (typeof value !== "object" || value === null) return [];
            const w = value as Record<string, unknown>;
            return [
              {
                type,
                utilization: numberOf(w.utilization),
                resetsAt: toMs(w.resetsAt),
                status: statusOf(w.status),
              },
            ];
          },
        )
      : [];
  if (windows.length === 0 && info.rateLimitType !== undefined) {
    windows.push({
      type: info.rateLimitType,
      utilization: numberOf(info.utilization),
      resetsAt: toMs(info.resetsAt),
      status: statusOf(info.status),
    });
  }
  return {
    observedAt,
    status: statusOf(info.status) ?? "allowed",
    rateLimitType: info.rateLimitType ?? null,
    resetsAt: toMs(info.resetsAt),
    windows,
  };
};
