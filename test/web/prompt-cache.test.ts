import { describe, expect, test } from "bun:test";
import type { ChatUIMessage } from "../../src/chat/chat-service.ts";
import type { PromptCacheObservation } from "../../src/provider/map-stream.ts";
import {
  estimatePromptCache,
  formatRemaining,
} from "../../src/web/lib/prompt-cache.ts";

const user: ChatUIMessage = {
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text: "質問" }],
};

const answer = (
  promptCache: Partial<PromptCacheObservation> | undefined,
  model = "opus",
): ChatUIMessage => ({
  id: crypto.randomUUID(),
  role: "assistant",
  parts: [{ type: "text", text: "回答" }],
  metadata: {
    model,
    claudeCode: {
      sessionId: "s",
      lastAssistantUuid: "u",
      costUsd: undefined,
      durationMs: undefined,
      numTurns: undefined,
      permissionDenials: [],
      ...(promptCache === undefined
        ? {}
        : {
            promptCache: {
              requestStartedAt: 0,
              cacheReadTokens: 0,
              cacheWrite5mTokens: 0,
              cacheWrite1hTokens: 0,
              ...promptCache,
            },
          }),
    },
  },
});

describe("estimatePromptCache", () => {
  test("回答が無ければ何も出さない", () => {
    expect(estimatePromptCache([user], "opus")).toEqual({ state: "none" });
  });

  test("最後のリクエストの開始時刻に、書き込んだ TTL を足す", () => {
    expect(
      estimatePromptCache(
        [user, answer({ requestStartedAt: 1_000, cacheWrite1hTokens: 10 })],
        "opus",
      ),
    ).toEqual({
      state: "active",
      expiresAt: 1_000 + 3_600_000,
      ttlSeconds: 3600,
    });
    expect(
      estimatePromptCache(
        [user, answer({ requestStartedAt: 1_000, cacheWrite5mTokens: 10 })],
        "opus",
      ),
    ).toEqual({ state: "active", expiresAt: 1_000 + 300_000, ttlSeconds: 300 });
  });

  test("読み込みだけなら、前に書き込んだときの TTL で延長する", () => {
    expect(
      estimatePromptCache(
        [
          user,
          answer({ requestStartedAt: 0, cacheWrite5mTokens: 10 }),
          user,
          answer({ requestStartedAt: 60_000, cacheReadTokens: 500 }),
        ],
        "opus",
      ),
    ).toMatchObject({ state: "active", expiresAt: 60_000 + 300_000 });
  });

  test("中断して観測の無い回答は飛ばし、それより前のリクエストを使う", () => {
    expect(
      estimatePromptCache(
        [
          user,
          answer({ requestStartedAt: 5, cacheWrite1hTokens: 10 }),
          user,
          answer(undefined),
        ],
        "opus",
      ),
    ).toMatchObject({ state: "active", expiresAt: 5 + 3_600_000 });
  });

  test("観測できない・使っていない・TTL が混在・TTL が分からない・モデルを変えたときは不明", () => {
    const cases: [ChatUIMessage[], string][] = [
      [[user, answer(undefined)], "opus"],
      [[user, answer({})], "opus"],
      [
        [user, answer({ cacheWrite5mTokens: 1, cacheWrite1hTokens: 1 })],
        "opus",
      ],
      [[user, answer({ cacheReadTokens: 100 })], "opus"],
      [[user, answer({ cacheWrite1hTokens: 1 })], "sonnet"],
    ];
    for (const [messages, model] of cases) {
      expect(estimatePromptCache(messages, model).state).toBe("unknown");
    }
  });
});

test("formatRemaining", () => {
  expect(formatRemaining(260_000)).toBe("4:20");
  expect(formatRemaining(3_600_000)).toBe("1:00:00");
  expect(formatRemaining(500)).toBe("0:01");
  expect(formatRemaining(-5)).toBe("0:00");
});
