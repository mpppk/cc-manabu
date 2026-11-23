import { Timer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChatUIMessage } from "../../chat/chat-service.ts";
import { estimatePromptCache, formatRemaining } from "../lib/prompt-cache.ts";

const NOTE =
  "直近のリクエストの開始時刻と TTL から見積もった目安です。次の送信でキャッシュが使われることは保証されません。";

/** プロンプトキャッシュの推定残り時間（#103）。期限は時刻で持ち、毎秒数え直す。 */
export const PromptCacheTimer = ({
  messages,
  model,
  busy,
}: {
  messages: ChatUIMessage[];
  model: string;
  busy: boolean;
}) => {
  const estimate = useMemo(
    () => estimatePromptCache(messages, model),
    [messages, model],
  );
  const [now, setNow] = useState(() => Date.now());
  const counting = estimate.state === "active" && !busy;
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  if (busy || estimate.state === "none") return null;
  const label =
    estimate.state === "unknown"
      ? "キャッシュ 不明"
      : estimate.expiresAt > now
        ? `キャッシュ 残り約 ${formatRemaining(estimate.expiresAt - now)}`
        : "キャッシュ 期限切れ";
  const title =
    estimate.state === "unknown"
      ? `${estimate.reason}\n${NOTE}`
      : `TTL ${estimate.ttlSeconds >= 3600 ? "1 時間" : "5 分"}（${new Date(
          estimate.expiresAt,
        ).toLocaleTimeString()} まで）\n${NOTE}`;
  return (
    <span
      className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs"
      title={title}
      data-testid="prompt-cache"
    >
      <Timer className="size-3.5" />
      {label}
    </span>
  );
};
