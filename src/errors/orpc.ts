import { ORPCError } from "@orpc/server";
import { Result } from "@praha/byethrow";

/** oRPC の共通エラーコードのうち、ハンドラで使うもの。 */
export type OrpcErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL_SERVER_ERROR"
  | "SERVICE_UNAVAILABLE";

/** エラー名（`error.name`）から oRPC のエラーコードへの対応表。 */
export type OrpcErrorCodeMap = Readonly<Record<string, OrpcErrorCode>>;

/**
 * 内部のエラーを ORPCError に変換する。対応表にないエラーは INTERNAL_SERVER_ERROR とし、
 * 内部の詳細をクライアントに漏らさないようにメッセージを伏せる。
 */
export const toOrpcError = (
  error: unknown,
  codeMap: OrpcErrorCodeMap = {},
): ORPCError<string, unknown> => {
  if (error instanceof ORPCError) {
    return error;
  }
  if (error instanceof Error) {
    const code = codeMap[error.name];
    if (code !== undefined) {
      return new ORPCError(code, { message: error.message, cause: error });
    }
  }
  return new ORPCError("INTERNAL_SERVER_ERROR", { cause: error });
};

/**
 * oRPC ハンドラの境界で Result を値に戻す。失敗なら ORPCError を throw する。
 */
export const unwrapForOrpc = async <T, E>(
  result: Result.ResultMaybeAsync<T, E>,
  codeMap: OrpcErrorCodeMap = {},
): Promise<T> => {
  const resolved = await result;
  if (Result.isFailure(resolved)) {
    throw toOrpcError(resolved.error, codeMap);
  }
  return resolved.value;
};
