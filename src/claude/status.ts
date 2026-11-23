import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import {
  type AccountSummary,
  type ClaudeProbe,
  getClaudeVersion,
  probeClaude,
} from "./detect.ts";

/** UI に返す Claude Code の状態。 */
export type ClaudeStatus =
  | { state: "checking"; path: string }
  | { state: "not_installed"; message: string }
  | {
      state: "ready";
      path: string;
      version: string | undefined;
      account: AccountSummary;
      models: ModelInfo[];
    }
  | {
      state: "error";
      path: string;
      version: string | undefined;
      message: string;
    };

/** 起動時に 1 回だけ Claude Code を調べ、結果を保持する。 */
export const createClaudeStatus = (
  initial: { found: true; path: string } | { found: false; message: string },
  deps: {
    probe?: (path: string) => Result.ResultAsync<ClaudeProbe, unknown>;
    version?: (path: string) => Promise<string | undefined>;
  } = {},
) => {
  let status: ClaudeStatus = initial.found
    ? { state: "checking", path: initial.path }
    : { state: "not_installed", message: initial.message };

  const ready: Promise<void> = initial.found
    ? (async () => {
        const path = initial.path;
        const version = await (deps.version ?? getClaudeVersion)(path).catch(
          () => undefined,
        );
        const probed = await (deps.probe ?? probeClaude)(path);
        status = Result.isSuccess(probed)
          ? { state: "ready", path, version, ...probed.value }
          : {
              state: "error",
              path,
              version,
              message:
                "Claude Code から情報を取得できませんでした。ターミナルで `claude` を実行し、ログインしているか確認してください。",
            };
      })()
    : Promise.resolve();

  return {
    get: (): ClaudeStatus => status,
    /** 調べ終わるまで待つ。 */
    ready,
  };
};

export type ClaudeStatusHolder = ReturnType<typeof createClaudeStatus>;
