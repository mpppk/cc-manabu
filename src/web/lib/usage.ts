import type { ChatUIMessage } from "../../chat/chat-service.ts";

export type UsageSummary = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
};

/** assistant メッセージの metadata から使用量を取り出す。 */
export const usageOf = (message: ChatUIMessage): UsageSummary | undefined => {
  const metadata = message.metadata;
  if (message.role !== "assistant" || metadata === undefined) {
    return undefined;
  }
  const usage = metadata.usage;
  const claudeCode = metadata.claudeCode;
  if (usage === undefined && claudeCode === undefined) {
    return undefined;
  }
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costUsd: claudeCode?.costUsd ?? 0,
    durationMs: claudeCode?.durationMs ?? 0,
  };
};

/** 会話全体の合計。 */
export const totalUsage = (messages: readonly ChatUIMessage[]): UsageSummary =>
  messages.reduce<UsageSummary>(
    (total, message) => {
      const usage = usageOf(message);
      return usage === undefined
        ? total
        : {
            inputTokens: total.inputTokens + usage.inputTokens,
            outputTokens: total.outputTokens + usage.outputTokens,
            costUsd: total.costUsd + usage.costUsd,
            durationMs: total.durationMs + usage.durationMs,
          };
    },
    { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
  );

/** 例: 「$0.0012・2.1 秒」。入出力トークン数は表示しない（#184）。 */
export const formatUsage = (usage: UsageSummary): string =>
  [
    `$${usage.costUsd.toFixed(4)}`,
    ...(usage.durationMs > 0
      ? [`${(usage.durationMs / 1000).toFixed(1)} 秒`]
      : []),
  ].join("・");
