import { expect, test } from "bun:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { resolveChatDefaults } from "../../src/chat/chat-defaults.ts";

const models: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default",
    description: "",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  { value: "haiku", displayName: "Haiku", description: "" },
];

test("保存値がなければ従来の既定値を使う", () => {
  expect(resolveChatDefaults(null, models)).toEqual({
    model: "default",
    effort: null,
  });
  expect(resolveChatDefaults(undefined, [])).toEqual({
    model: "default",
    effort: null,
  });
});

test("保存したモデルと effort が使えるなら、そのまま使う", () => {
  expect(
    resolveChatDefaults({ model: "default", effort: "high" }, models),
  ).toEqual({ model: "default", effort: "high" });
});

test("保存したモデルが一覧に無ければ既定のモデルにする", () => {
  expect(
    resolveChatDefaults({ model: "removed", effort: "high" }, models),
  ).toEqual({ model: "default", effort: null });
});

test("保存した effort が選んだモデルで使えなければ effort を既定に戻す", () => {
  expect(
    resolveChatDefaults({ model: "haiku", effort: "high" }, models),
  ).toEqual({ model: "haiku", effort: null });
  expect(
    resolveChatDefaults({ model: "default", effort: "max" }, models),
  ).toEqual({ model: "default", effort: null });
});

test("モデルの一覧がまだ無いときは保存値をそのまま使う", () => {
  expect(resolveChatDefaults({ model: "haiku", effort: "low" }, [])).toEqual({
    model: "haiku",
    effort: "low",
  });
});
