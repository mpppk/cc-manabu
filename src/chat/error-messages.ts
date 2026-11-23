import {
  ClaudeCodeApiError,
  ClaudeCodeExecutionError,
  ClaudeCodeNotFoundError,
  isAuthenticationError,
} from "../provider/index.ts";

/** 生成中のエラーを、UI に出す日本語のメッセージにする。 */
export const toUserErrorMessage = (error: unknown): string => {
  if (error instanceof ClaudeCodeNotFoundError) {
    return "Claude Code（claude コマンド）が見つかりません。インストールしてから cc-manabu を起動し直してください。";
  }
  if (isAuthenticationError(error)) {
    return "Claude Code にログインしていません。ターミナルで `claude` を実行してログインしてください。";
  }
  if (error instanceof ClaudeCodeApiError) {
    switch (error.kind) {
      case "rate_limit":
        return "利用上限に達しました。しばらく待ってから送信してください。";
      case "overloaded":
      case "server_error":
        return "Claude が混み合っています。しばらく待ってから送信してください。";
      case "billing_error":
      case "account_on_hold":
        return "アカウントの状態により利用できません。Claude のアカウント設定を確認してください。";
      case "model_not_found":
        return "選択したモデルを利用できません。別のモデルを選んでください。";
      default:
        return `Claude からエラーが返されました（${error.kind}）。`;
    }
  }
  if (error instanceof ClaudeCodeExecutionError) {
    return `Claude Code の実行に失敗しました（${error.subtype}）。`;
  }
  return "予期しないエラーが発生しました。";
};
