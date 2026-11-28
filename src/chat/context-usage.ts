import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { ContextUsage } from "../db/schema.ts";

/**
 * getContextUsage({ detail: "summary" }) の答えから、残して表示する部分（#245）。
 * 割合は SDK が返すいまのコンテキストの使用量と上限から計算したもの。会話全体の累計トークンや
 * プランの利用量は含めない。
 */
export const toContextUsage = (
  response: SDKControlGetContextUsageResponse,
  now: Date,
): ContextUsage => ({
  totalTokens: response.totalTokens,
  maxTokens: response.maxTokens,
  percentage:
    response.maxTokens > 0
      ? Math.min(100, (response.totalTokens / response.maxTokens) * 100)
      : response.percentage,
  model: response.model,
  categories: response.categories
    .filter((category) => category.tokens > 0 || category.kind === "free")
    .map((category) => ({
      ...(category.id === undefined ? {} : { id: category.id }),
      name: category.name,
      tokens: category.tokens,
      kind: category.kind,
    })),
  capturedAt: now.toISOString(),
});
