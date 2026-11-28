import { createContext } from "react";
import type { AgentStatuses } from "../../agents/status.ts";

/** Claude Code 以外の AI（Codex・GitHub Copilot）の状態（#265）。読み込むまでは undefined。 */
export const AgentsContext = createContext<AgentStatuses | undefined>(
  undefined,
);
