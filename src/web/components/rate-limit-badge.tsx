import { Gauge } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { RateLimitSnapshot } from "../../chat/rate-limit.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { describeWeeklyRateLimit } from "../lib/rate-limit.ts";
import { cn } from "../lib/utils.ts";

/** 取り直す間隔。利用枠は回答のたびにサーバへ届く。 */
const POLL_MS = 15_000;

/**
 * サブスクリプションの利用枠とリセット時刻（#116）。メインの入力欄の下に出し、
 * 週間（7 日間）の枠を優先して出す（#170）。押すと、ほかの枠（5 時間枠など）を含む詳細を開く。
 * まだ観測していなければ何も出さない。
 */
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
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const detailsId = useId();
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

  // 開いているときは、外側を押すか Escape で閉じる
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (snapshot === null) return null;
  const view = describeWeeklyRateLimit(snapshot, now);
  return (
    <span ref={root} className="relative flex min-w-0">
      <button
        type="button"
        className={cn(
          "flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent",
          view.tone === "normal" && "text-muted-foreground",
          view.tone === "warning" &&
            "bg-amber-500/15 text-amber-700 dark:text-amber-400",
          view.tone === "danger" && "bg-destructive/15 text-destructive",
        )}
        title={view.details.join("\n")}
        aria-label={`利用枠: ${view.label}`}
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        data-testid="rate-limit"
        onClick={() => setOpen(!open)}
      >
        <Gauge className="size-3.5 shrink-0" aria-hidden />
        <span className="hidden truncate 2xl:inline">{view.label}</span>
        {view.short !== "" && (
          <span className="truncate 2xl:hidden">{view.short}</span>
        )}
      </button>
      {open && (
        <span
          id={detailsId}
          role="dialog"
          aria-label="利用枠の詳細"
          className="absolute right-0 bottom-full z-30 mb-1 flex w-72 flex-col gap-1 rounded-md border bg-background p-3 text-left text-xs shadow-lg"
        >
          <span className="font-medium text-sm">利用枠の詳細</span>
          {view.details.map((line) => (
            <span key={line} className="text-muted-foreground">
              {line}
            </span>
          ))}
        </span>
      )}
    </span>
  );
};
