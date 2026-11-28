import type {
  RateLimitSnapshot,
  RateLimitWindow,
} from "../../chat/rate-limit.ts";

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5 時間",
  seven_day: "7 日間",
  seven_day_opus: "7 日間（Opus）",
  seven_day_sonnet: "7 日間（Sonnet）",
  seven_day_overage_included: "7 日間",
  overage: "追加利用",
};

export const windowLabel = (type: string): string =>
  WINDOW_LABELS[type] ?? type;

/** この割合以上なら注意を促す。 */
const WARNING_UTILIZATION = 0.8;

const pad = (n: number) => String(n).padStart(2, "0");

/** リセット時刻。24 時間以内なら時刻だけ、それより先なら日付も付ける。 */
export const formatResetTime = (at: number, now: number): string => {
  const date = new Date(at);
  const time = `${date.getHours()}:${pad(date.getMinutes())}`;
  return at - now < 24 * 60 * 60 * 1000
    ? time
    : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
};

const percent = (utilization: number) => `${Math.round(utilization * 100)}%`;

export type RateLimitView = {
  label: string;
  /** 狭い画面で出す短い表記（利用率など）。 */
  short: string;
  tone: "normal" | "warning" | "danger";
  /** ツールチップに出す行。 */
  details: string[];
};

const isCurrent = (window: RateLimitWindow, now: number) =>
  window.resetsAt === null || window.resetsAt > now;

/**
 * 最後に観測した利用枠を、ヘッダーに出す文言にする（#116）。
 * いちばん使っている枠を出す。リセット時刻を過ぎた枠の利用率は古いので「リセット済み」とする。
 */
export const describeRateLimit = (
  snapshot: RateLimitSnapshot,
  now: number,
): RateLimitView => {
  const details = snapshot.windows.map((window) => {
    const name = `${windowLabel(window.type)}枠`;
    if (!isCurrent(window, now)) return `${name}: リセット済み`;
    const used =
      window.utilization === null ? "利用率不明" : percent(window.utilization);
    const reset =
      window.resetsAt === null
        ? ""
        : `（${formatResetTime(window.resetsAt, now)} にリセット）`;
    return `${name}: ${used}${reset}`;
  });
  const observed = new Date(snapshot.observedAt);
  details.push(
    `最終確認 ${formatResetTime(snapshot.observedAt, snapshot.observedAt)}${
      now - snapshot.observedAt >= 24 * 60 * 60 * 1000
        ? `（${observed.getMonth() + 1}/${observed.getDate()}）`
        : ""
    }。回答のたびに更新します。`,
  );

  const rejected =
    snapshot.status === "rejected" &&
    (snapshot.resetsAt === null || snapshot.resetsAt > now);
  if (rejected) {
    return {
      label:
        snapshot.resetsAt === null
          ? "利用上限に達しました"
          : `利用上限（${formatResetTime(snapshot.resetsAt, now)} にリセット）`,
      short: "上限",
      tone: "danger",
      details,
    };
  }
  const current = snapshot.windows.filter(
    (w) => isCurrent(w, now) && w.utilization !== null,
  );
  const top = current.reduce<RateLimitWindow | undefined>(
    (best, w) =>
      best === undefined || (w.utilization ?? 0) > (best.utilization ?? 0)
        ? w
        : best,
    undefined,
  );
  if (top === undefined || top.utilization === null) {
    return {
      label: snapshot.windows.length > 0 ? "利用枠 リセット済み" : "利用枠",
      short: "",
      tone: "normal",
      details,
    };
  }
  const warning =
    top.utilization >= WARNING_UTILIZATION ||
    current.some(
      (w) => w.status === "allowed_warning" || w.status === "rejected",
    );
  return {
    short: percent(top.utilization),
    label: `${windowLabel(top.type)}枠 ${percent(top.utilization)}${
      top.resetsAt === null
        ? ""
        : `・${formatResetTime(top.resetsAt, now)} にリセット`
    }`,
    tone: warning ? "warning" : "normal",
    details,
  };
};

/** 時刻（端末のタイムゾーン、24 時間表記の HH:mm）。 */
export const formatClock = (at: number): string => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** 取れていない値の表示。 */
const MISSING = "—";

/**
 * メインの入力欄の下に出す利用枠（#278）。5 時間枠の利用率と次のリセット時刻を「57% 17:00」の形で出す。
 * 取れていない値（リセット時刻を過ぎて古くなった値を含む）は「—」にする。
 * 上限に達していれば赤、どれかの枠が上限に近ければ黄色にする（詳細は押して開く）。
 */
export const describeFiveHourRateLimit = (
  snapshot: RateLimitSnapshot,
  now: number,
): RateLimitView => {
  const overall = describeRateLimit(snapshot, now);
  const window = snapshot.windows.find((w) => w.type === "five_hour");
  const current = window !== undefined && isCurrent(window, now);
  const used =
    current && window.utilization !== null
      ? percent(window.utilization)
      : MISSING;
  const reset =
    current && window.resetsAt !== null
      ? formatClock(window.resetsAt)
      : MISSING;
  const warning = snapshot.windows.some(
    (w) =>
      isCurrent(w, now) &&
      ((w.utilization ?? 0) >= WARNING_UTILIZATION ||
        w.status === "allowed_warning" ||
        w.status === "rejected"),
  );
  return {
    short: `${used} ${reset}`,
    label: `5 時間枠 ${used === MISSING ? "利用率不明" : used}・${
      reset === MISSING ? "リセット時刻不明" : `${reset} にリセット`
    }`,
    tone: overall.tone === "danger" ? "danger" : warning ? "warning" : "normal",
    details: overall.details,
  };
};
