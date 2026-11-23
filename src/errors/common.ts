import { ErrorFactory } from "@praha/error-factory";

/**
 * 想定外の失敗（インフラ障害やライブラリの例外など）を包むエラー。
 * 元の例外は `cause` に保持する。
 */
export class UnexpectedError extends ErrorFactory({
  name: "UnexpectedError",
  message: "An unexpected error occurred",
}) {}

/** unknown な値を Error に正規化する。Error 以外は UnexpectedError で包む。 */
export const toError = (value: unknown): Error =>
  value instanceof Error ? value : new UnexpectedError({ cause: value });
