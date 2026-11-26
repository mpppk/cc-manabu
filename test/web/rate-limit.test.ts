import { describe, expect, test } from "bun:test";
import type { RateLimitSnapshot } from "../../src/chat/rate-limit.ts";
import {
  describeRateLimit,
  describeWeeklyRateLimit,
} from "../../src/web/lib/rate-limit.ts";

const HOUR = 60 * 60 * 1000;
const now = new Date(2026, 10, 24, 12, 0).getTime();

const snapshot = (
  overrides: Partial<RateLimitSnapshot> = {},
): RateLimitSnapshot => ({
  observedAt: now - 60_000,
  status: "allowed",
  rateLimitType: "five_hour",
  resetsAt: now + 2 * HOUR,
  windows: [
    {
      type: "five_hour",
      utilization: 0.62,
      resetsAt: now + 2 * HOUR,
      status: "allowed",
    },
    {
      type: "seven_day",
      utilization: 0.4,
      resetsAt: now + 72 * HOUR,
      status: "allowed",
    },
  ],
  ...overrides,
});

describe("describeRateLimit（#116）", () => {
  test("いちばん使っている枠と、そのリセット時刻を出す", () => {
    const view = describeRateLimit(snapshot(), now);
    expect(view).toEqual({
      label: "5 時間枠 62%・14:00 にリセット",
      short: "62%",
      tone: "normal",
      details: [
        "5 時間枠: 62%（14:00 にリセット）",
        "7 日間枠: 40%（11/27 12:00 にリセット）",
        "最終確認 11:59。回答のたびに更新します。",
      ],
    });
  });

  test("80% 以上や allowed_warning なら注意、rejected なら上限", () => {
    const high = snapshot();
    if (high.windows[1]) high.windows[1].utilization = 0.85;
    expect(describeRateLimit(high, now)).toMatchObject({
      label: "7 日間枠 85%・11/27 12:00 にリセット",
      tone: "warning",
    });
    expect(
      describeRateLimit(snapshot({ status: "rejected" }), now),
    ).toMatchObject({
      label: "利用上限（14:00 にリセット）",
      short: "上限",
      tone: "danger",
    });
  });

  test("リセット時刻を過ぎた枠は古いので使わない", () => {
    const view = describeRateLimit(
      snapshot({ status: "rejected" }),
      now + 3 * HOUR,
    );
    expect(view.tone).toBe("normal");
    expect(view.label).toBe("7 日間枠 40%・11/27 12:00 にリセット");
    expect(view.details[0]).toBe("5 時間枠: リセット済み");
    expect(describeRateLimit(snapshot(), now + 100 * HOUR).label).toBe(
      "利用枠 リセット済み",
    );
  });
});

describe("describeWeeklyRateLimit（#170）", () => {
  test("5 時間枠のほうが使っていても、週間の枠を出す", () => {
    const view = describeWeeklyRateLimit(snapshot(), now);
    expect(view.label).toBe("7 日間枠 40%・11/27 12:00 にリセット");
    expect(view.short).toBe("週 40%・11/27 12:00 リセット");
    expect(view.tone).toBe("normal");
    expect(view.details[0]).toBe("5 時間枠: 62%（14:00 にリセット）");
  });

  test("5 時間枠が上限に近ければ添えて注意を促す", () => {
    const view = describeWeeklyRateLimit(
      snapshot({
        windows: [
          {
            type: "five_hour",
            utilization: 0.92,
            resetsAt: now + 2 * HOUR,
            status: "allowed_warning",
          },
          {
            type: "seven_day",
            utilization: 0.4,
            resetsAt: now + 72 * HOUR,
            status: "allowed",
          },
        ],
      }),
      now,
    );
    expect(view.label).toBe(
      "7 日間枠 40%・11/27 12:00 にリセット（5 時間枠 92%）",
    );
    expect(view.tone).toBe("warning");
  });

  test("上限に達していれば、上限の表示を引き継ぐ", () => {
    const view = describeWeeklyRateLimit(
      snapshot({ status: "rejected", resetsAt: now + HOUR }),
      now,
    );
    expect(view.tone).toBe("danger");
    expect(view.label).toBe("利用上限（13:00 にリセット）");
  });

  test("週間の枠が無ければ、いちばん使っている枠を出す", () => {
    const only = snapshot();
    const view = describeWeeklyRateLimit(
      { ...only, windows: only.windows.slice(0, 1) },
      now,
    );
    expect(view.label).toBe("5 時間枠 62%・14:00 にリセット");
  });
});
