import type {
  CanUseTool,
  Options,
  PermissionMode,
  Query,
  SDKMessage,
  SDKUserMessage,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";

/** Agent SDK の `query()` と同じ形の関数。テストでは fixture を流す実装に差し替える。 */
export type QueryFunction = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query | AsyncIterable<SDKMessage>;

/** Provider 全体の設定。起動時に 1 回決まるもの。 */
export type ClaudeCodeProviderSettings = {
  /** 利用者の `claude` 実行ファイル。単一バイナリでは必須（docs/spikes/compile-agent-sdk.md）。 */
  pathToClaudeCodeExecutable?: string;
  /** ツールが操作する作業ディレクトリ。既定は process.cwd()。 */
  cwd?: string;
  /** 読み込む Claude Code の設定。既定は user / project / local すべて。 */
  settingSources?: SettingSource[];
  /** `claude_code` preset のシステムプロンプトに追記する文字列。 */
  appendSystemPrompt?: string;
  /** ツール実行の承認。承認フロー（#29）から渡す。 */
  canUseTool?: CanUseTool;
  /** 既定の permission mode。 */
  permissionMode?: PermissionMode;
  /** Claude Code に渡す環境変数。省略時は process.env。 */
  env?: Record<string, string | undefined>;
  /** Agent SDK の query() の差し替え（テスト用）。 */
  query?: QueryFunction;
};

/**
 * 呼び出しごとの設定。`streamText({ providerOptions: { "claude-code": … } })` で渡す。
 * effort は AI SDK 標準の `reasoning` オプションで渡す。
 */
export type ClaudeCodeCallOptions = {
  /** resume するセッション ID。無ければ新規セッション。 */
  sessionId?: string;
  /** 再生成・編集で巻き戻す地点（直前のターンの最後の assistant uuid）。 */
  resumeSessionAt?: string;
  /** true なら resume 時に新しいセッションへ分岐する。 */
  forkSession?: boolean;
  /**
   * 質問の前に別の text ブロックとして渡す参照資料（Wiki の抜粋など）。
   * resume でもターンごとに届く（docs/spikes/per-turn-context.md）。
   */
  context?: string;
};

export const PROVIDER_NAME = "claude-code";

/** モデル ID。エイリアス（Claude Code が解決する）かフル ID。 */
export type ClaudeCodeModelId =
  | "default"
  | "opus"
  | "sonnet"
  | "fable"
  | "haiku"
  | (string & {});
