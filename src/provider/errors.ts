import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
import { ErrorFactory } from "@praha/error-factory";

/** `claude` 実行ファイルが見つからない。 */
export class ClaudeCodeNotFoundError extends ErrorFactory({
  name: "ClaudeCodeNotFoundError",
  message: (fields) =>
    `Claude Code executable was not found${fields.path === undefined ? "" : ` at ${fields.path}`}.`,
  fields: ErrorFactory.fields<{ path: string | undefined }>(),
}) {}

/**
 * Claude（API・アカウント側）のエラー。`assistant.error` から作る。
 * kind で認証・課金・レート制限などを区別する。
 */
export class ClaudeCodeApiError extends ErrorFactory({
  name: "ClaudeCodeApiError",
  message: (fields) => `Claude Code API error: ${fields.kind}`,
  fields: ErrorFactory.fields<{
    kind: SDKAssistantMessageError;
    detail: string | undefined;
  }>(),
}) {}

/** ターンの実行に失敗した（`result` が error_* で終わった）。 */
export class ClaudeCodeExecutionError extends ErrorFactory({
  name: "ClaudeCodeExecutionError",
  message: (fields) =>
    `Claude Code failed: ${fields.subtype}${fields.errors.length > 0 ? ` (${fields.errors.join("; ")})` : ""}`,
  fields: ErrorFactory.fields<{ subtype: string; errors: string[] }>(),
}) {}

/** Claude Code のプロセスが想定外の例外を投げた。 */
export class ClaudeCodeProcessError extends ErrorFactory({
  name: "ClaudeCodeProcessError",
  message: (fields) => `Claude Code process error: ${fields.detail}`,
  fields: ErrorFactory.fields<{ detail: string }>(),
}) {}

export type ClaudeCodeError =
  | ClaudeCodeNotFoundError
  | ClaudeCodeApiError
  | ClaudeCodeExecutionError
  | ClaudeCodeProcessError;

/** ログインし直す必要があるエラーか。 */
export const isAuthenticationError = (error: unknown): boolean =>
  error instanceof ClaudeCodeApiError &&
  (error.kind === "authentication_failed" ||
    error.kind === "oauth_org_not_allowed" ||
    error.kind === "verification_required");

/** 時間をおけば解消しうるエラーか。 */
export const isRetryableError = (error: unknown): boolean =>
  error instanceof ClaudeCodeApiError &&
  (error.kind === "rate_limit" ||
    error.kind === "overloaded" ||
    error.kind === "server_error");

const NOT_FOUND_PATTERN = /binary not found|executable not found|ENOENT/i;

/** query() が投げた例外を分類する。 */
export const classifyThrownError = (
  error: unknown,
  claudePath: string | undefined,
): ClaudeCodeError => {
  const detail = error instanceof Error ? error.message : String(error);
  if (NOT_FOUND_PATTERN.test(detail)) {
    return new ClaudeCodeNotFoundError({ path: claudePath, cause: error });
  }
  return new ClaudeCodeProcessError({ detail, cause: error });
};
