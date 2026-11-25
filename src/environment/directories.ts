import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

export class DirectoryNotFoundError extends ErrorFactory({
  name: "DirectoryNotFoundError",
  message: (fields) => `ディレクトリが見つかりません: ${fields.path}`,
  fields: ErrorFactory.fields<{ path: string }>(),
}) {}

export class RelativeDirectoryError extends ErrorFactory({
  name: "RelativeDirectoryError",
  message: (fields) =>
    `ディレクトリは絶対パス（/ か ~/ で始まるパス）で指定してください: ${fields.path}`,
  fields: ErrorFactory.fields<{ path: string }>(),
}) {}

export type DirectoryError = DirectoryNotFoundError | RelativeDirectoryError;

/** ディレクトリかどうか。テストでは差し替える。 */
export type IsDirectory = (path: string) => boolean;

const isDirectoryOnDisk: IsDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** `~` と `~/…` をホームディレクトリに展開し、末尾の `/` などを整える。 */
export const expandDirectory = (path: string, home = homedir()): string => {
  const trimmed = path.trim();
  const expanded =
    trimmed === "~"
      ? home
      : trimmed.startsWith("~/")
        ? join(home, trimmed.slice(2))
        : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : expanded;
};

/** ディレクトリかどうかを非同期に確かめる（デスクトップアプリ版はファイル操作が非同期）。 */
export type IsDirectoryAsync = (path: string) => Promise<boolean>;

/** 環境のディレクトリを確かめて整える関数。router の context から差し替える。 */
export type DirectoryNormalizer = (
  paths: readonly string[],
) =>
  | Result.Result<string[], DirectoryError>
  | Result.ResultAsync<string[], DirectoryError>;

/**
 * {@link normalizeDirectories} の非同期版。ホームディレクトリも引数で受け取る
 * （ブラウザで動くデスクトップアプリ版は node:os を使えないため）。
 */
export const normalizeDirectoriesAsync = async (
  paths: readonly string[],
  deps: { isDirectory: IsDirectoryAsync; home: string },
): Result.ResultAsync<string[], DirectoryError> => {
  const normalized: string[] = [];
  for (const path of paths) {
    const expanded = expandDirectory(path, deps.home);
    if (!isAbsolute(expanded)) {
      return Result.fail(new RelativeDirectoryError({ path }));
    }
    if (!(await deps.isDirectory(expanded))) {
      return Result.fail(new DirectoryNotFoundError({ path: expanded }));
    }
    if (!normalized.includes(expanded)) normalized.push(expanded);
  }
  return Result.succeed(normalized);
};

/**
 * 環境のディレクトリを確かめて整える。絶対パス（`~` を含む）で、実在するディレクトリだけを受け付け、
 * 重複は先に出たほうを残す。
 */
export const normalizeDirectories = (
  paths: readonly string[],
  isDirectory: IsDirectory = isDirectoryOnDisk,
): Result.Result<string[], DirectoryError> => {
  const normalized: string[] = [];
  for (const path of paths) {
    const expanded = expandDirectory(path);
    if (!isAbsolute(expanded)) {
      return Result.fail(new RelativeDirectoryError({ path }));
    }
    if (!isDirectory(expanded)) {
      return Result.fail(new DirectoryNotFoundError({ path: expanded }));
    }
    if (!normalized.includes(expanded)) normalized.push(expanded);
  }
  return Result.succeed(normalized);
};
