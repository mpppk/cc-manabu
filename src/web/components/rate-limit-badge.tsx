import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import type { RateLimitSnapshot } from "../../chat/rate-limit.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { describeRateLimit } from "../lib/rate-limit.ts";
import { cn } from "../lib/utils.ts";

/** 取り直す間隔。利用枠は回答のたびにサーバへ届く。 */
const POLL_MS = 15_000;

/** サブスクリプションの利用枠とリセット時刻（#116）。まだ観測していなければ何も出さない。 */
export const RateLimitBadge = ({
  api,
  activity,
}: {
  api: ApiClient;
  /** 会話が更新されたら変わる値。変わったら取り直す（回答のあとすぐ反映する）。 */
  activity: string;
}) => {
  const [snapshot, setSnapshot] = useState<RateLimitSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: activity が変わったら取り直す
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      api.limits
        .get()
        .then((next) => {
          if (cancelled) return;
          setNow(Date.now());
          setSnapshot((current) =>
            JSON.stringify(current) === JSON.stringify(next) ? current : next,
          );
        })
        .catch(() => {});
    };
    refresh();
    // 回答の直後は、利用枠の保存が一覧の更新より少し遅れることがあるので取り直す
    const again = setTimeout(refresh, 1500);
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(again);
      clearInterval(timer);
    };
  }, [api, activity]);

  if (snapshot === null) return null;
  const view = describeRateLimit(snapshot, now);
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs",
        view.tone === "normal" && "text-muted-foreground",
        view.tone === "warning" &&
          "bg-amber-500/15 text-amber-700 dark:text-amber-400",
        view.tone === "danger" && "bg-destructive/15 text-destructive",
      )}
      title={view.details.join("\n")}
      data-testid="rate-limit"
    >
      <Gauge className="size-3.5 shrink-0" />
      <span className="hidden xl:inline">{view.label}</span>
      {view.short !== "" && <span className="xl:hidden">{view.short}</span>}
    </span>
  );
};
