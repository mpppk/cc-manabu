import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { ChatUIMessage } from "../../src/chat/chat-service.ts";
import { ModelPicker } from "../../src/web/components/model-picker.tsx";
import { formatUsage, totalUsage, usageOf } from "../../src/web/lib/usage.ts";

const assistant = (
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): ChatUIMessage => ({
  id: crypto.randomUUID(),
  role: "assistant",
  parts: [],
  metadata: {
    usage: {
      inputTokens,
      outputTokens,
      reasoningTokens: undefined,
      cachedInputTokens: undefined,
      totalTokens: inputTokens + outputTokens,
    },
    claudeCode: {
      sessionId: "s",
      lastAssistantUuid: "u",
      costUsd,
      durationMs: 2000,
      numTurns: 1,
      permissionDenials: [],
    },
  },
});

describe("usage", () => {
  test("assistant メッセージの使用量を取り出し、合計する", () => {
    const messages: ChatUIMessage[] = [
      { id: "u1", role: "user", parts: [] },
      assistant(1000, 50, 0.001),
      assistant(2000, 70, 0.002),
    ];
    expect(usageOf(messages[0] as ChatUIMessage)).toBeUndefined();
    expect(totalUsage(messages)).toEqual({
      inputTokens: 3000,
      outputTokens: 120,
      costUsd: 0.003,
      durationMs: 4000,
    });
  });

  test("表示用に整形し、入出力トークン数は出さない（#184）", () => {
    expect(
      formatUsage({
        inputTokens: 1234,
        outputTokens: 56,
        costUsd: 0.0012,
        durationMs: 2100,
      }),
    ).toBe("$0.0012・2.1 秒");
  });
});

describe("ModelPicker", () => {
  const models = [
    {
      value: "sonnet",
      displayName: "Sonnet",
      description: "",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"] as ("low" | "high")[],
    },
    { value: "haiku-4", displayName: "Haiku 4", description: "" },
  ];

  test("effort はモデルが対応する選択肢だけ出す", () => {
    const html = renderToString(
      <ModelPicker
        models={models}
        model="sonnet"
        effort={null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("effort: 既定");
    expect(html).toMatch(/effort: (<!-- -->)?低/);
    expect(html).toMatch(/effort: (<!-- -->)?高/);
    expect(html).not.toMatch(/effort: (<!-- -->)?最大/);
  });

  test("effort に対応しないモデルでは effort 欄を出さない", () => {
    expect(
      renderToString(
        <ModelPicker
          models={models}
          model="haiku-4"
          effort={null}
          onChange={() => {}}
        />,
      ),
    ).not.toContain("effort");
  });

  test("一覧に無いモデル（取得前など）も選択肢に残す", () => {
    expect(
      renderToString(
        <ModelPicker
          models={[]}
          model="default"
          effort={null}
          onChange={() => {}}
        />,
      ),
    ).toContain(">default<");
  });
});
