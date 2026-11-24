import { describe, expect, test } from "bun:test";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { normalizeRateLimit } from "../../src/chat/rate-limit.ts";

describe("normalizeRateLimit（#116）", () => {
  test("実機の unifiedWindows から、枠ごとの利用率とリセット時刻（ミリ秒）を取り出す", () => {
    const info = {
      status: "allowed",
      resetsAt: 1795494000,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      unifiedWindows: {
        five_hour: {
          utilization: 0.62,
          resetsAt: 1795494000,
          status: "allowed",
        },
        seven_day: {
          utilization: 0.67,
          resetsAt: 1795633200,
          status: "allowed_warning",
        },
        broken: "x",
      },
    } as unknown as SDKRateLimitInfo;
    expect(normalizeRateLimit(info, 123)).toEqual({
      observedAt: 123,
      status: "allowed",
      rateLimitType: "five_hour",
      resetsAt: 1795494000_000,
      windows: [
        {
          type: "five_hour",
          utilization: 0.62,
          resetsAt: 1795494000_000,
          status: "allowed",
        },
        {
          type: "seven_day",
          utilization: 0.67,
          resetsAt: 1795633200_000,
          status: "allowed_warning",
        },
      ],
    });
  });

  test("unifiedWindows が無ければ、型にある 1 つの枠を使う", () => {
    const snapshot = normalizeRateLimit(
      {
        status: "rejected",
        resetsAt: 1795494000,
        rateLimitType: "seven_day_opus",
        utilization: 1,
      },
      0,
    );
    expect(snapshot.status).toBe("rejected");
    expect(snapshot.windows).toEqual([
      {
        type: "seven_day_opus",
        utilization: 1,
        resetsAt: 1795494000_000,
        status: "rejected",
      },
    ]);
  });

  test("枠の情報が無ければ windows は空", () => {
    expect(normalizeRateLimit({ status: "allowed" }, 0)).toEqual({
      observedAt: 0,
      status: "allowed",
      rateLimitType: null,
      resetsAt: null,
      windows: [],
    });
  });
});
