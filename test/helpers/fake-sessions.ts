import { Result } from "@praha/byethrow";
import {
  DesktopLaunchError,
  type DesktopLauncher,
  type SessionReader,
  type TranscriptEntry,
} from "../../src/claude/sessions.ts";
import type { ChatRepository } from "../../src/db/chat-repository.ts";

/**
 * ローカルの Claude Code セッションの代わり（#244）。Monet が保存した会話から記録を組み立て、
 * Claude Desktop・CLI で足した発言（appendExternal）を、足した時点の位置に差し込む。
 */
export const createFakeSessions = (chats: ChatRepository) => {
  /** セッションごとの、外で足した発言と、足したときの Monet のメッセージの数。 */
  const external = new Map<
    string,
    { at: number; entries: TranscriptEntry[] }[]
  >();
  const touched = new Map<string, number>();
  const launches: { sessionId: string; cwd: string }[] = [];
  let launchFailure: string | undefined;
  let onLaunch: ((sessionId: string) => void) | undefined;

  const chatOf = (sessionId: string) => {
    const listed = chats.listChats();
    if (Result.isFailure(listed)) return undefined;
    const chat = listed.value.find((row) => row.sessionId === sessionId);
    if (chat === undefined) return undefined;
    const found = chats.getChat(chat.id);
    return Result.isSuccess(found) ? found.value : undefined;
  };

  const transcriptOf = (sessionId: string): TranscriptEntry[] => {
    const found = chatOf(sessionId);
    if (found === undefined) return [];
    const own: TranscriptEntry[] = found.messages.map((message) => ({
      type: message.role === "user" ? "user" : "assistant",
      uuid: message.sdkUuid ?? `monet-${message.id}`,
      message: {
        role: message.role,
        content: [{ type: "text", text: "Monet の発言" }],
      },
    }));
    const inserts = external.get(sessionId) ?? [];
    const result: TranscriptEntry[] = [];
    own.forEach((entry, index) => {
      for (const insert of inserts) {
        if (insert.at === index) result.push(...insert.entries);
      }
      result.push(entry);
    });
    for (const insert of inserts) {
      if (insert.at >= own.length) result.push(...insert.entries);
    }
    return result;
  };

  const reader: SessionReader = {
    lastModified: async (sessionId) =>
      chatOf(sessionId) === undefined
        ? undefined
        : (touched.get(sessionId) ?? 0) + transcriptOf(sessionId).length * 1000,
    messages: async (sessionId) => transcriptOf(sessionId),
  };

  const launchDesktop: DesktopLauncher = async (input) => {
    if (launchFailure !== undefined) {
      return Result.fail(new DesktopLaunchError({ reason: launchFailure }));
    }
    launches.push(input);
    onLaunch?.(input.sessionId);
    return Result.succeed(undefined);
  };

  /** Claude Desktop・CLI で、質問と回答を 1 組足す。 */
  const appendExternal = (sessionId: string, question: string) => {
    const at = chatOf(sessionId)?.messages.length ?? 0;
    const id = crypto.randomUUID();
    const list = external.get(sessionId) ?? [];
    list.push({
      at,
      entries: [
        {
          type: "user",
          uuid: `ext-q-${id}`,
          message: { role: "user", content: question },
        },
        {
          type: "assistant",
          uuid: `ext-a-${id}`,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `了解: ${question}` }],
          },
        },
      ],
    });
    external.set(sessionId, list);
  };

  return {
    reader,
    launchDesktop,
    launches,
    appendExternal,
    /** タイトルの変更など、発言を増やさずに更新日時だけを変える。 */
    touch: (sessionId: string) =>
      touched.set(sessionId, (touched.get(sessionId) ?? 0) + 1),
    /** 起動を失敗させる（undefined で元に戻す）。 */
    failLaunch: (reason: string | undefined) => {
      launchFailure = reason;
    },
    /** 起動したときの動き（Desktop で発言を足す、など）。 */
    setOnLaunch: (fn: ((sessionId: string) => void) | undefined) => {
      onLaunch = fn;
    },
  };
};
