import path from "node:path";

/**
 * DB ファイルのパス。XDG Base Directory に従う。
 * CC_MANABU_DB → $XDG_DATA_HOME/cc-manabu/db.sqlite → ~/.local/share/cc-manabu/db.sqlite
 */
export const resolveDbPath = (
  env: Record<string, string | undefined> = process.env,
): string => {
  if (env.CC_MANABU_DB !== undefined && env.CC_MANABU_DB !== "") {
    return env.CC_MANABU_DB;
  }
  const xdg = env.XDG_DATA_HOME;
  if (xdg !== undefined && path.isAbsolute(xdg)) {
    return path.join(xdg, "cc-manabu", "db.sqlite");
  }
  const home = env.HOME ?? env.USERPROFILE ?? "";
  return path.join(home, ".local", "share", "cc-manabu", "db.sqlite");
};
