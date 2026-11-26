/**
 * `/goal` の評価の結果を、Claude Code のセッションの記録から読む（#198、docs/spikes/goal.md）。
 * 判定は SDK のストリームには出ず、記録（`<設定ディレクトリ>/projects/<…>/<セッション ID>.jsonl`）の
 * `attachment` に `goal_status` として残る。
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type GoalVerdict =
  /** 達成を確認した。 */
  | { kind: "met"; reason: string }
  /** 達成不能と判定した。 */
  | { kind: "failed"; reason: string }
  /** 判定が無い（未達成のまま止まった・記録を読めない）。 */
  | { kind: "none"; reason: string };

/** 記録のテキストから、最後の評価（ゴールを設定したときの印は除く）を読む。 */
export const parseGoalVerdict = (transcript: string): GoalVerdict => {
  let last: GoalVerdict = { kind: "none", reason: "" };
  for (const line of transcript.split("\n")) {
    if (!line.includes('"goal_status"')) continue;
    try {
      const entry: unknown = JSON.parse(line);
      const attachment =
        typeof entry === "object" && entry !== null && "attachment" in entry
          ? (entry.attachment as Record<string, unknown>)
          : undefined;
      if (attachment?.type !== "goal_status" || attachment.sentinel === true) {
        continue;
      }
      const reason =
        typeof attachment.reason === "string" ? attachment.reason : "";
      last =
        attachment.met === true
          ? { kind: "met", reason }
          : attachment.failed === true
            ? { kind: "failed", reason }
            : { kind: "none", reason };
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return last;
};

/** Claude Code の設定ディレクトリ（CLAUDE_CONFIG_DIR があればそれ）。 */
const configDir = () =>
  process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");

export type GoalVerdictReader = (sessionId: string) => Promise<GoalVerdict>;

/** セッションの記録を探して、最後の評価を読む。見つからなければ none。 */
export const readGoalVerdict: GoalVerdictReader = async (sessionId) => {
  if (!/^[0-9a-f-]+$/i.test(sessionId)) return { kind: "none", reason: "" };
  const projects = path.join(configDir(), "projects");
  const dirs = await readdir(projects).catch(() => [] as string[]);
  for (const dir of dirs) {
    const text = await readFile(
      path.join(projects, dir, `${sessionId}.jsonl`),
      "utf8",
    ).catch(() => undefined);
    if (text !== undefined) return parseGoalVerdict(text);
  }
  return { kind: "none", reason: "" };
};
