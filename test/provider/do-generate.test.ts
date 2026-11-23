import { describe, expect, test } from "bun:test";
import { generateText } from "ai";
import {
  ClaudeCodeProcessError,
  createClaudeCode,
  PROVIDER_NAME,
} from "../../src/provider/index.ts";
import { createFakeQuery, loadFixture } from "./fake-query.ts";

const modelFor = async (fixture: string) => {
  const { query } = createFakeQuery(await loadFixture(fixture));
  return createClaudeCode({ query })("haiku");
};

describe("doGenerate", () => {
  test("テキストをまとめて返す（text-partial）", async () => {
    const result = await generateText({
      model: await modelFor("text-partial"),
      prompt: "hi",
    });
    expect(result.text).toBe("こんにちは");
    expect(result.finishReason).toBe("stop");
    expect(result.providerMetadata?.[PROVIDER_NAME]?.sessionId).toBeString();
    expect(result.response.modelId).toBe("claude-haiku-5-5");
  });

  test("ツールの呼び出しと結果、その後のテキストを順に返す（tool-read）", async () => {
    const result = await generateText({
      model: await modelFor("tool-read"),
      prompt: "hi",
    });
    const types = result.content.map((c) => c.type);
    expect(types.indexOf("tool-call")).toBeLessThan(
      types.indexOf("tool-result"),
    );
    expect(types.indexOf("tool-result")).toBeLessThan(
      types.lastIndexOf("text"),
    );
    expect(result.text).toContain("Hello from cc-manabu!");
    expect(result.steps).toHaveLength(1);
  });

  test("reasoning を含む（thinking）", async () => {
    const result = await generateText({
      model: await modelFor("thinking"),
      prompt: "hi",
    });
    expect(result.content.map((c) => c.type)).toContain("reasoning");
  });

  test("途中でエラーになったら例外にする", async () => {
    const { query } = createFakeQuery([{ type: "__error__", message: "boom" }]);
    expect(
      generateText({
        model: createClaudeCode({ query })("haiku"),
        prompt: "hi",
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(ClaudeCodeProcessError);
  });
});
