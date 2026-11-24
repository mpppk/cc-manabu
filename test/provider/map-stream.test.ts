import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  mapFinishReason,
  mapUsage,
  StreamMapper,
} from "../../src/provider/map-stream.ts";

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

describe("StreamMapper のプロンプトキャッシュ（#103）", () => {
  const event = (usage: unknown, parent: string | null = null) =>
    ({
      type: "stream_event",
      session_id: "s",
      parent_tool_use_id: parent,
      uuid: crypto.randomUUID(),
      event: { type: "message_start", message: { usage } },
    }) as unknown as SDKMessage;
  const other = {
    type: "system",
    subtype: "status",
    session_id: "s",
    uuid: "u",
  } as unknown as SDKMessage;

  test("最後のメインのリクエストについて、直前のメッセージの時刻と書き込みの内訳を残す", () => {
    let clock = 1_000;
    const mapper = new StreamMapper(() => clock);
    clock = 2_000;
    mapper.map(other);
    clock = 2_600;
    mapper.map(
      event({
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 2546,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 2546,
        },
      }),
    );
    expect(mapper.metadata().promptCache).toEqual({
      requestStartedAt: 2_000,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 2546,
    });

    // ツールのあとの次のリクエスト（読み込みだけ）で置き換わる。サブエージェントのものは無視する
    clock = 5_000;
    mapper.map(other);
    clock = 5_500;
    mapper.map(event({ cache_read_input_tokens: 3000 }));
    clock = 6_000;
    mapper.map(
      event(
        {
          cache_creation_input_tokens: 10,
          cache_creation: { ephemeral_5m_input_tokens: 10 },
        },
        "toolu_1",
      ),
    );
    expect(mapper.metadata().promptCache).toEqual({
      requestStartedAt: 5_000,
      cacheReadTokens: 3000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    });
  });

  test("書き込みの内訳が無ければ、TTL を決めないよう両方に入れる", () => {
    const mapper = new StreamMapper(() => 0);
    mapper.map(event({ cache_creation_input_tokens: 100 }));
    expect(mapper.metadata().promptCache).toMatchObject({
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 100,
    });
  });

  test("message_start に usage が無ければ観測しない", () => {
    const mapper = new StreamMapper(() => 0);
    mapper.map(event(undefined));
    expect(mapper.metadata().promptCache).toBeUndefined();
  });
});
