import { describe, expect, test } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { streamText } from "ai";
import {
  ClaudeCodeApiError,
  ClaudeCodeExecutionError,
  ClaudeCodeNotFoundError,
  ClaudeCodeProcessError,
  createClaudeCode,
  isAuthenticationError,
  isRetryableError,
} from "../../src/provider/index.ts";
import type { QueryFunction } from "../../src/provider/types.ts";
import { createFakeQuery, loadFixture } from "./fake-query.ts";

const prompt = [
  { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
];

const collect = async (query: QueryFunction, claudePath?: string) => {
  const model = createClaudeCode({
    query,
    pathToClaudeCodeExecutable: claudePath,
  })("haiku");
  const { stream } = await model.doStream({ prompt });
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return parts;
};

const errorOf = (parts: LanguageModelV4StreamPart[]) =>
  parts.find((p) => p.type === "error")?.error;

describe("assistant.error", () => {
  test("認証エラーは ClaudeCodeApiError(authentication_failed) になる", async () => {
    const lines = await loadFixture("text-no-partial");
    const assistant = lines.find((l) => l.type === "assistant") as Extract<
      SDKMessage,
      { type: "assistant" }
    >;
    const failed = {
      ...assistant,
      error: "authentication_failed",
      message: {
        ...assistant.message,
        content: [{ type: "text", text: "Not logged in · Please run /login" }],
      },
    };
    const { query } = createFakeQuery([failed as SDKMessage]);
    const error = errorOf(await collect(query));
    expect(error).toBeInstanceOf(ClaudeCodeApiError);
    expect(error).toMatchObject({
      kind: "authentication_failed",
      detail: "Not logged in · Please run /login",
    });
    expect(isAuthenticationError(error)).toBe(true);
    expect(isRetryableError(error)).toBe(false);
  });

  test("レート制限は再試行できるエラー", () => {
    const error = new ClaudeCodeApiError({
      kind: "rate_limit",
      detail: undefined,
    });
    expect(isRetryableError(error)).toBe(true);
    expect(isAuthenticationError(error)).toBe(false);
  });
});

describe("result の失敗", () => {
  test("error_during_execution は error パーツと finish(error) を流す", async () => {
    const lines = await loadFixture("text-partial");
    const result = lines.find((l) => l.type === "result");
    const failed = {
      ...result,
      subtype: "error_during_execution",
      is_error: true,
      errors: ["something went wrong"],
    };
    const { query } = createFakeQuery([failed as SDKMessage]);
    const parts = await collect(query);
    const error = errorOf(parts);
    expect(error).toBeInstanceOf(ClaudeCodeExecutionError);
    expect((error as Error).message).toContain("something went wrong");
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "error" },
    });
  });
});

describe("query() の例外", () => {
  test("実行ファイルが見つからなければ ClaudeCodeNotFoundError", async () => {
    const { query } = createFakeQuery([
      {
        type: "__error__",
        message:
          "Claude Code native binary not found at /nope/claude. Please ensure Claude Code is installed",
      },
    ]);
    const error = errorOf(await collect(query, "/nope/claude"));
    expect(error).toBeInstanceOf(ClaudeCodeNotFoundError);
    expect((error as Error).message).toContain("/nope/claude");
  });

  test("query() が同期的に例外を投げても error パーツにする", async () => {
    const query: QueryFunction = () => {
      throw new Error("spawn failed");
    };
    const error = errorOf(await collect(query));
    expect(error).toBeInstanceOf(ClaudeCodeProcessError);
  });

  test("streamText 経由では onError に分類済みのエラーが届く", async () => {
    const { query } = createFakeQuery([{ type: "__error__", message: "boom" }]);
    const errors: unknown[] = [];
    const result = streamText({
      model: createClaudeCode({ query })("haiku"),
      prompt: "hi",
      onError: ({ error }) => {
        errors.push(error);
      },
    });
    await result.consumeStream();
    expect(errors[0]).toBeInstanceOf(ClaudeCodeProcessError);
  });
});
