import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { ChatUIMessage } from "../../src/chat/chat-service.ts";
import {
  groupModels,
  ModelPicker,
} from "../../src/web/components/model-picker.tsx";
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

  test("一覧に無いモデル（取得前など）も、選択中のモデル名として表示する", () => {
    expect(
      renderToString(
        <ModelPicker
          models={[]}
          model="claude-opus-4-1"
          effort={null}
          onChange={() => {}}
        />,
      ),
    ).toContain(">claude-opus-4-1<");
  });

  test("選択中のモデルの表示名をボタンに出す", () => {
    expect(
      renderToString(
        <ModelPicker
          models={models}
          model="haiku-4"
          effort={null}
          onChange={() => {}}
        />,
      ),
    ).toContain('aria-label="モデル: Haiku 4"');
  });
});

describe("groupModels（#183）", () => {
  const m = (value: string) => ({ value, displayName: value });

  test("最初の階層には利用可能な Fable・Opus・Sonnet・Haiku をこの順に並べ、残りはその他にまとめる", () => {
    const grouped = groupModels(
      [
        m("default"),
        m("haiku"),
        m("sonnet"),
        m("claude-opus-4-1"),
        m("sonnet[1m]"),
        m("opus"),
        m("fable"),
      ],
      "default",
    );
    expect(grouped.primary.map((x) => x.value)).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(grouped.others.map((x) => x.value)).toEqual([
      "default",
      "claude-opus-4-1",
      "sonnet[1m]",
    ]);
  });

  test("利用できないシリーズは出さない", () => {
    expect(
      groupModels([m("default"), m("sonnet")], "sonnet").primary.map(
        (x) => x.value,
      ),
    ).toEqual(["sonnet"]);
  });

  test("一覧に無い選択中のモデル（古いスレッドなど）はその他の先頭に残す", () => {
    expect(
      groupModels([m("default"), m("opus")], "claude-sonnet-4-5").others.map(
        (x) => x.value,
      ),
    ).toEqual(["claude-sonnet-4-5", "default"]);
  });
});
