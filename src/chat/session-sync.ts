import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import {
  countUnimportedPrompts,
  type DesktopLaunchError,
  type DesktopLauncher,
  type SessionReader,
} from "../claude/sessions.ts";
import type {
  ChatNotFoundError,
  ChatRepository,
  DatabaseError,
} from "../db/chat-repository.ts";
import type { ChatRow, MessageRow } from "../db/schema.ts";

/**
 * 会話の Claude Code セッションと、Monet に保存した履歴の照合の結果（#244）。
 *
 * - no_session: まだセッションが無い（何も送っていない分岐など）
 * - busy: 生成中・承認待ち（Monet 自身が書き込んでいるので照合しない）
 * - missing: セッションのファイルが見つからない（別の PC で作った・消したなど）
 * - unknown: 照合できなかった（読めない・Monet の回答がセッションに見つからない）
 * - synced: Monet の外で足された質問は無い
 * - unimported: Monet の外（Claude Desktop・CLI）で足された質問がある
 */
export type SessionSyncState =
  | { state: "no_session" }
  | { state: "busy" }
  | { state: "missing" }
  | { state: "unknown" }
  | { state: "synced" }
  | { state: "unimported"; prompts: number };

export class ChatSessionMissingError extends ErrorFactory({
  name: "ChatSessionMissingError",
  message:
    "この会話にはまだ Claude Code のセッションがありません。最初のメッセージを送ってから開いてください。",
}) {}

export class ChatBusyError extends ErrorFactory({
  name: "ChatBusyError",
  message:
    "生成中・承認待ちの会話は Claude Desktop で開けません。回答が終わってから開いてください。",
}) {}

const isBusy = (chat: ChatRow) =>
  chat.status === "running" || chat.status === "awaiting_approval";

/** 照合のやり直しが要るかを見分ける、Monet 側の履歴の印。 */
const signatureOf = (messages: readonly MessageRow[]) =>
  `${messages.length}:${messages.at(-1)?.id ?? ""}:${messages.at(-1)?.sdkUuid ?? ""}`;

/**
 * Claude Code のセッションとの照合（#244）と、Claude Desktop で開く操作。
 * 照合は読み取りだけで、Claude の生成もセッションへの書き込みもしない。
 * セッションの最終更新日時と Monet の履歴が前回と同じなら、記録を読み直さない。
 */
export const createSessionSync = (deps: {
  chats: ChatRepository;
  reader: SessionReader;
  launchDesktop: DesktopLauncher;
}) => {
  const cache = new Map<
    string,
    {
      sessionId: string;
      lastModified: number;
      signature: string;
      result: SessionSyncState;
    }
  >();

  const compare = async (
    chat: ChatRow & { sessionId: string },
    messages: MessageRow[],
  ): Promise<SessionSyncState> => {
    const lastModified = await deps.reader.lastModified(
      chat.sessionId,
      chat.cwd,
    );
    if (lastModified === undefined) return { state: "missing" };
    const signature = signatureOf(messages);
    const cached = cache.get(chat.id);
    if (
      cached?.sessionId === chat.sessionId &&
      cached.lastModified === lastModified &&
      cached.signature === signature
    ) {
      return cached.result;
    }
    const transcript = await deps.reader.messages(chat.sessionId, chat.cwd);
    const prompts = countUnimportedPrompts(messages, transcript);
    const result: SessionSyncState =
      prompts === undefined
        ? { state: "unknown" }
        : prompts > 0
          ? { state: "unimported", prompts }
          : { state: "synced" };
    cache.set(chat.id, {
      sessionId: chat.sessionId,
      lastModified,
      signature,
      result,
    });
    return result;
  };

  return {
    /** 表示中の会話のセッションに、Monet に取り込んでいない質問があるか。 */
    check: async (
      chatId: string,
    ): Promise<
      Result.Result<SessionSyncState, ChatNotFoundError | DatabaseError>
    > => {
      const found = deps.chats.getChat(chatId);
      if (Result.isFailure(found)) return found;
      const { chat, messages } = found.value;
      if (chat.sessionId === null)
        return Result.succeed({ state: "no_session" });
      if (isBusy(chat)) return Result.succeed({ state: "busy" });
      try {
        return Result.succeed(
          await compare({ ...chat, sessionId: chat.sessionId }, messages),
        );
      } catch {
        // 読めなくても会話は使える。照合できなかったことだけを返す
        return Result.succeed({ state: "unknown" });
      }
    },

    /** 会話のセッションを、作業ディレクトリから Claude Desktop で開く。 */
    openInDesktop: async (
      chatId: string,
    ): Promise<
      Result.Result<
        void,
        | ChatNotFoundError
        | DatabaseError
        | ChatSessionMissingError
        | ChatBusyError
        | DesktopLaunchError
      >
    > => {
      const found = deps.chats.getChat(chatId);
      if (Result.isFailure(found)) return found;
      const { chat } = found.value;
      if (chat.sessionId === null) {
        return Result.fail(new ChatSessionMissingError());
      }
      if (isBusy(chat)) return Result.fail(new ChatBusyError());
      return deps.launchDesktop({ sessionId: chat.sessionId, cwd: chat.cwd });
    },
  };
};

export type SessionSync = ReturnType<typeof createSessionSync>;
