import { Bot } from "lucide-react";
import { useId } from "react";
import type { AgentStatus, AgentStatuses } from "../../agents/status.ts";
import type { AgentId } from "../../db/schema.ts";

/** AI の表示名（#265）。 */
export const AGENT_NAMES: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
};

const ORDER: readonly AgentId[] = ["claude-code", "codex", "copilot"];

/** AI の状態（Claude Code は Monet 自体の前提なので、いつも使える扱い）。 */
export const agentStatusOf = (
  agents: AgentStatuses | undefined,
  agent: AgentId,
): AgentStatus =>
  agent === "claude-code"
    ? { state: "ready", models: [] }
    : (agents?.[agent] ?? { state: "checking" });

/**
 * 新規スレッドの最初の送信の前に、会話に使う AI を選ぶ（#265）。
 * 使えない AI も選択肢に残し、選ぶと理由と設定の手順を出す（AI は切り替えない）。
 */
export const AgentPicker = ({
  agent,
  agents,
  disabled,
  onChange,
}: {
  agent: AgentId;
  agents: AgentStatuses | undefined;
  disabled?: boolean;
  onChange: (agent: AgentId) => void;
}) => {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className="flex shrink-0 items-center gap-1 rounded-md text-muted-foreground text-xs"
      title="この会話に使う AI（最初の送信のあとは変えられません）"
    >
      <Bot aria-hidden className="size-3.5" />
      <select
        id={id}
        aria-label="AI"
        className="h-8 max-w-36 truncate rounded-md bg-transparent px-1 outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        value={agent}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as AgentId)}
      >
        {ORDER.map((option) => {
          const status = agentStatusOf(agents, option);
          return (
            <option key={option} value={option}>
              {AGENT_NAMES[option]}
              {status.state === "unavailable"
                ? "（使えません）"
                : status.state === "checking"
                  ? "（確認中）"
                  : ""}
            </option>
          );
        })}
      </select>
    </label>
  );
};

/** 選んだ AI が使えない理由と、使えるようにする手順。 */
export const AgentUnavailableNotice = ({
  agent,
  status,
  onDismiss,
}: {
  agent: AgentId;
  status: AgentStatus;
  onDismiss: () => void;
}) =>
  status.state === "ready" ? null : (
    <div
      role="alert"
      className="mx-auto mb-2 flex max-w-3xl flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <p className="font-medium">
        {AGENT_NAMES[agent]} は使えません:{" "}
        {status.state === "checking"
          ? "状態を確かめています。しばらくしてから選び直してください。"
          : status.reason}
      </p>
      {status.state === "unavailable" && status.setup.length > 0 && (
        <ol className="list-decimal pl-5 text-muted-foreground text-xs">
          {status.setup.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      <button
        type="button"
        className="self-end rounded-sm px-2 py-0.5 text-muted-foreground text-xs hover:bg-accent"
        onClick={onDismiss}
      >
        閉じる
      </button>
    </div>
  );
