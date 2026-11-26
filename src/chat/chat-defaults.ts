import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Effort } from "./chat-service.ts";

/** 新規スレッドの初期値にする、最後に選んだモデルと effort（#164）。 */
export type ChatDefaults = { model: string; effort: Effort | null };

/** 保存値がないときに使う、従来の既定値。 */
export const FALLBACK_CHAT_DEFAULTS: ChatDefaults = {
  model: "default",
  effort: null,
};

/**
 * 保存した初期値を、いま選べるモデルに合わせる。
 * - モデルが一覧に無くなっていれば既定のモデルにする
 * - effort がそのモデルで使えなければ既定の effort にする
 * - モデルの一覧がまだ無い（取得前・取得失敗）ときは、保存値をそのまま使う
 */
export const resolveChatDefaults = (
  saved: ChatDefaults | null | undefined,
  models: readonly ModelInfo[],
): ChatDefaults => {
  if (saved == null) return FALLBACK_CHAT_DEFAULTS;
  if (models.length === 0) return saved;
  const model = models.find((m) => m.value === saved.model);
  if (model === undefined) return FALLBACK_CHAT_DEFAULTS;
  const efforts =
    model.supportsEffort === true ? (model.supportedEffortLevels ?? []) : [];
  return {
    model: model.value,
    effort:
      saved.effort !== null && (efforts as string[]).includes(saved.effort)
        ? saved.effort
        : null,
  };
};
