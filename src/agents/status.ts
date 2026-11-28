/**
 * Claude Code 以外の AI（Codex・GitHub Copilot）が使えるかどうか（#265）。
 * 起動時に 1 回だけ調べ、選択画面と送信時に、使えない理由と設定の手順を出す。
 */
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import type { AgentId } from "../db/schema.ts";
import {
  type CodexAppServer,
  connectCodex,
  type SpawnAppServer,
  spawnCodexAppServer,
} from "../provider/codex/app-server.ts";

/** UI に返す、AI の状態。 */
export type AgentStatus =
  | { state: "checking" }
  | { state: "ready"; models: ModelInfo[] }
  | {
      state: "unavailable";
      /** 使えない理由。 */
      reason: string;
      /** 使えるようにする手順。 */
      setup: string[];
    };

export type AgentStatuses = Record<
  Exclude<AgentId, "claude-code">,
  AgentStatus
>;

/** AI の表示名。 */
export const AGENT_LABELS: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
};

const CODEX_INSTALL = [
  "Codex CLI をインストールする（例: `npm install -g @openai/codex` または `brew install codex`）",
  "ターミナルで `codex login` を実行してログインする",
  "Monet を起動し直す",
];

const COPILOT_INSTALL = [
  "GitHub Copilot CLI をインストールする（例: `npm install -g @github/copilot`）",
  "ターミナルで `copilot` を起動し、`/login` でログインする",
  "Monet を起動し直す",
];

/** Codex の effort のうち、Monet で選べるもの。 */
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

type CodexModel = {
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  isDefault: boolean;
};

/** Codex のモデル一覧を、Claude Code と同じ形（ModelInfo）にする。既定のモデルを先頭にする。 */
export const toModelInfos = (models: readonly CodexModel[]): ModelInfo[] =>
  [...models]
    .filter((model) => !model.hidden)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map((model) => {
      const efforts = model.supportedReasoningEfforts
        .map((option) => option.reasoningEffort)
        .filter((effort) => EFFORTS.has(effort));
      return {
        value: model.model,
        displayName: model.displayName,
        description: model.description,
        supportsEffort: efforts.length > 0,
        supportedEffortLevels: efforts as ModelInfo["supportedEffortLevels"],
      } as ModelInfo;
    });

/** Codex を調べる（インストール・ログイン・モデル一覧）。 */
export const probeCodex = async (deps: {
  which: () => string | null;
  spawn?: SpawnAppServer;
  clientVersion: string;
}): Promise<AgentStatus> => {
  const path = deps.which();
  if (path === null) {
    return {
      state: "unavailable",
      reason: "Codex CLI（`codex`）が見つかりません。",
      setup: CODEX_INSTALL,
    };
  }
  const connected = await connectCodex(
    deps.spawn ?? spawnCodexAppServer(path),
    deps.clientVersion,
  );
  if (Result.isFailure(connected)) {
    return {
      state: "unavailable",
      reason: `Codex に接続できませんでした（${connected.error.message}）。`,
      setup: CODEX_INSTALL,
    };
  }
  const server: CodexAppServer = connected.value;
  try {
    const account = await server.request<{ account: unknown }>(
      "account/read",
      {},
    );
    if (Result.isFailure(account) || account.value.account == null) {
      return {
        state: "unavailable",
        reason: "Codex にログインしていません。",
        setup: [
          "ターミナルで `codex login` を実行してログインする",
          "Monet を起動し直す",
        ],
      };
    }
    const models = await server.request<{ data: CodexModel[] }>(
      "model/list",
      {},
    );
    if (Result.isFailure(models)) {
      return {
        state: "unavailable",
        reason: `Codex のモデル一覧を取得できませんでした（${models.error.message}）。`,
        setup: CODEX_INSTALL,
      };
    }
    const infos = toModelInfos(models.value.data);
    return infos.length === 0
      ? {
          state: "unavailable",
          reason: "Codex で使えるモデルがありません。",
          setup: ["Codex のプランと設定を確認する"],
        }
      : { state: "ready", models: infos };
  } finally {
    server.close();
  }
};

/** GitHub Copilot を調べる。接続はまだ実装していないので、見つかっても使えない理由を返す。 */
export const probeCopilot = (deps: {
  which: () => string | null;
}): AgentStatus =>
  deps.which() === null
    ? {
        state: "unavailable",
        reason: "GitHub Copilot CLI（`copilot`）が見つかりません。",
        setup: COPILOT_INSTALL,
      }
    : {
        state: "unavailable",
        reason:
          "この版の Monet は、GitHub Copilot との会話にまだ対応していません。",
        setup: ["Monet の更新を待つ"],
      };

/** 起動時に 1 回だけ調べ、結果を保持する。 */
export const createAgentStatuses = (probes: {
  codex: () => Promise<AgentStatus>;
  copilot: () => Promise<AgentStatus>;
}) => {
  const statuses: AgentStatuses = {
    codex: { state: "checking" },
    copilot: { state: "checking" },
  };
  const ready: Promise<void> = Promise.all(
    (["codex", "copilot"] as const).map(async (agent) => {
      try {
        statuses[agent] = await probes[agent]();
      } catch {
        statuses[agent] = {
          state: "unavailable",
          reason: `${AGENT_LABELS[agent]} の状態を確かめられませんでした。`,
          setup: [],
        };
      }
    }),
  ).then(() => undefined);
  return {
    get: (): AgentStatuses => ({ ...statuses }),
    ready,
  };
};

export type AgentStatusHolder = ReturnType<typeof createAgentStatuses>;
