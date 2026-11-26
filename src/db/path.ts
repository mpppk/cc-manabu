import { existsSync } from "node:fs";
import path from "node:path";
import { readEnv } from "../env.ts";

/** 改名前（#188）のアプリ名。既存の DB を引き継ぐのに使う。 */
const LEGACY_APP_DIR = "cc-manabu";
const APP_DIR = "monet";

/**
 * DB ファイルのパス。XDG Base Directory に従う。
 * MONET_DB（CC_MANABU_DB）→ $XDG_DATA_HOME/monet/db.sqlite → ~/.local/share/monet/db.sqlite
 *
 * 新しい場所に DB が無く、改名前の場所（…/cc-manabu/db.sqlite）にあれば、そちらをそのまま使う
 * （会話・タスク・Wiki を引き継ぐ。ファイルは移さない）。
 */
export const resolveDbPath = (
  env: Record<string, string | undefined> = process.env,
  exists: (file: string) => boolean = existsSync,
): string => {
  const configured = readEnv(env, "DB");
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  const xdg = env.XDG_DATA_HOME;
  const base =
    xdg !== undefined && path.isAbsolute(xdg)
      ? xdg
      : path.join(env.HOME ?? env.USERPROFILE ?? "", ".local", "share");
  const current = path.join(base, APP_DIR, "db.sqlite");
  const legacy = path.join(base, LEGACY_APP_DIR, "db.sqlite");
  return !exists(current) && exists(legacy) ? legacy : current;
};
