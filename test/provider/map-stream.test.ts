import { describe, expect, test } from "bun:test";
import { mapFinishReason, mapUsage } from "../../src/provider/map-stream.ts";

describe("mapFinishReason", () => {
  test.each([
    ["success", "end_turn", "stop"],
    ["success", "stop_sequence", "stop"],
    ["success", null, "stop"],
    ["success", "max_tokens", "length"],
    ["success", "tool_use", "tool-calls"],
    ["success", "refusal", "content-filter"],
    ["success", "pause_turn", "other"],
    ["error_max_turns", "tool_use", "length"],
    ["error_max_budget_usd", null, "length"],
    ["error_during_execution", null, "error"],
  ] as const)("%s / %s → %s", (subtype, stopReason, unified) => {
    expect(mapFinishReason({ subtype, stop_reason: stopReason }).unified).toBe(
      unified,
    );
  });

  test("raw には stop_reason、無ければ subtype を入れる", () => {
    expect(
      mapFinishReason({ subtype: "success", stop_reason: "end_turn" }).raw,
    ).toBe("end_turn");
    expect(
      mapFinishReason({ subtype: "error_max_turns", stop_reason: null }).raw,
    ).toBe("error_max_turns");
  });
});

describe("mapUsage", () => {
  test("キャッシュを含めた入力トークンの合計と、thinking のトークンを分ける", () => {
    const usage = mapUsage({
      input_tokens: 2,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 900,
      output_tokens: 100,
      output_tokens_details: { thinking_tokens: 30 },
    } as never);
    expect(usage).toEqual({
      inputTokens: { total: 1402, noCache: 2, cacheRead: 500, cacheWrite: 900 },
      outputTokens: { total: 100, text: 70, reasoning: 30 },
    });
  });

  test("usage が無ければすべて undefined", () => {
    expect(mapUsage(undefined).inputTokens.total).toBeUndefined();
  });
});
