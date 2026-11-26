import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { TASK_READ_TOOL_NAMES } from "../task/tool-names.ts";
import { WIKI_READ_TOOL_NAMES } from "../wiki/tool-names.ts";

/**
 * Claude Code が自動で許可しない読み取り系のうち、monet が承認なしで許可するツール。
 * WebFetch は URL 経由で情報を外に送れるので含めない（docs/spikes/permissions.md）。
 * Wiki とタスクのツールは読むものだけ許可し、書き換えるものは承認を求める。
 */
export const AUTO_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "TodoWrite",
  ...WIKI_READ_TOOL_NAMES,
  ...TASK_READ_TOOL_NAMES,
]);

export type ApprovalStatus = "pending" | "allowed" | "denied";

/** UI に送る承認要求（data-approval パーツの data）。 */
export type ApprovalData = {
  approvalId: string;
  toolName: string;
  toolUseId: string | undefined;
  displayName: string | undefined;
  description: string | undefined;
  input: Record<string, unknown>;
  status: ApprovalStatus;
  /** 拒否の理由（拒否したときだけ）。 */
  message?: string;
};

export type ApprovalChunk = {
  type: "data-approval";
  id: string;
  data: ApprovalData;
};

export class ApprovalNotFoundError extends ErrorFactory({
  name: "ApprovalNotFoundError",
  message: (fields) => `Approval not found: ${fields.approvalId}`,
  fields: ErrorFactory.fields<{ approvalId: string }>(),
}) {}

export const DEFAULT_DENY_MESSAGE = "ユーザーが拒否しました。";
const ABORTED_MESSAGE = "生成が中断されたため、実行しませんでした。";

type Pending = {
  chatId: string;
  data: ApprovalData;
  resolve: (result: PermissionResult) => void;
  emit: (chunk: ApprovalChunk) => void;
};

/**
 * ツール実行の承認を、Claude Code の canUseTool と UI の間で受け渡す（開発計画 §2.4）。
 *
 * 1. canUseTool が呼ばれたら pending を登録し、data-approval（pending）を流す
 * 2. UI が respond() で答えると Promise を解決し、data-approval（allowed / denied）を流す
 * 3. 中断されたら pending を deny で解決する
 */
export const createApprovalBroker = (
  options: {
    onPendingChange?: (chatId: string, pendingCount: number) => void;
  } = {},
) => {
  const pending = new Map<string, Pending>();

  const countFor = (chatId: string) =>
    [...pending.values()].filter((p) => p.chatId === chatId).length;

  const settle = (
    approvalId: string,
    result: PermissionResult,
    message?: string,
  ) => {
    const entry = pending.get(approvalId);
    if (entry === undefined) {
      return;
    }
    pending.delete(approvalId);
    const status: ApprovalStatus =
      result.behavior === "allow" ? "allowed" : "denied";
    entry.emit({
      type: "data-approval",
      id: approvalId,
      data: {
        ...entry.data,
        status,
        ...(message === undefined ? {} : { message }),
      },
    });
    entry.resolve(result);
    options.onPendingChange?.(entry.chatId, countFor(entry.chatId));
  };

  return {
    /** 会話ごとの canUseTool を作る。emit は ChatRunner のストリームにチャンクを書く関数。 */
    createCanUseTool:
      (chatId: string, emit: (chunk: ApprovalChunk) => void): CanUseTool =>
      (toolName, input, context) => {
        if (AUTO_ALLOWED_TOOLS.has(toolName)) {
          return Promise.resolve({ behavior: "allow", updatedInput: input });
        }
        if (context.signal.aborted) {
          return Promise.resolve({
            behavior: "deny",
            message: ABORTED_MESSAGE,
          });
        }
        const approvalId = crypto.randomUUID();
        const data: ApprovalData = {
          approvalId,
          toolName,
          toolUseId: context.toolUseID,
          displayName: context.displayName,
          description: context.description,
          input,
          status: "pending",
        };
        return new Promise<PermissionResult>((resolve) => {
          pending.set(approvalId, { chatId, data, resolve, emit });
          emit({ type: "data-approval", id: approvalId, data });
          options.onPendingChange?.(chatId, countFor(chatId));
          context.signal.addEventListener(
            "abort",
            () =>
              settle(
                approvalId,
                { behavior: "deny", message: ABORTED_MESSAGE },
                ABORTED_MESSAGE,
              ),
            { once: true },
          );
        });
      },

    /** UI からの回答。別の会話の承認には答えられない。 */
    respond: (input: {
      chatId: string;
      approvalId: string;
      behavior: "allow" | "deny";
      message?: string;
    }): Result.Result<void, ApprovalNotFoundError> => {
      const entry = pending.get(input.approvalId);
      if (entry === undefined || entry.chatId !== input.chatId) {
        return Result.fail(
          new ApprovalNotFoundError({ approvalId: input.approvalId }),
        );
      }
      if (input.behavior === "allow") {
        settle(input.approvalId, {
          behavior: "allow",
          updatedInput: entry.data.input,
        });
      } else {
        const message =
          input.message?.trim() === "" || input.message === undefined
            ? DEFAULT_DENY_MESSAGE
            : input.message;
        settle(input.approvalId, { behavior: "deny", message }, message);
      }
      return Result.succeed();
    },

    /** 会話の保留中の承認をすべて拒否する（生成を止めたときなど）。 */
    denyAll: (chatId: string): void => {
      for (const [approvalId, entry] of pending) {
        if (entry.chatId === chatId) {
          settle(
            approvalId,
            { behavior: "deny", message: ABORTED_MESSAGE },
            ABORTED_MESSAGE,
          );
        }
      }
    },

    pendingFor: (chatId: string): ApprovalData[] =>
      [...pending.values()]
        .filter((entry) => entry.chatId === chatId)
        .map((entry) => entry.data),
  };
};

export type ApprovalBroker = ReturnType<typeof createApprovalBroker>;
