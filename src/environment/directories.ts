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
