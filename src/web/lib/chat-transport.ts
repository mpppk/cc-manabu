import type { ChatTransport, UIMessageChunk } from "ai";
import type { ChatUIMessage, Effort } from "../../chat/chat-service.ts";
import type { ApiClient } from "./orpc.ts";
import { peekIterable, toReadableStream } from "./stream.ts";

export type SendSettings = {
  model?: string;
  effort?: Effort | null;
};

/**
 * useChat から oRPC（chat.send / chat.regenerate / chat.reconnect）を呼ぶ ChatTransport。
 *
 * - abortSignal（useChat の stop）で切れるのは購読だけ。サーバ側の生成を止めるには chat.stop を呼ぶ
 * - サーバは再接続時にバッファを先頭から流し直すので resumeStreamIsReplay を true にする
 */
export class OrpcChatTransport implements ChatTransport<ChatUIMessage> {
  readonly resumeStreamIsReplay = true;

  constructor(
    private readonly api: ApiClient,
    private readonly settings: () => SendSettings = () => ({}),
  ) {}

  async sendMessages({
    trigger,
    chatId,
    messages,
    abortSignal,
  }: Parameters<ChatTransport<ChatUIMessage>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const options = abortSignal === undefined ? {} : { signal: abortSignal };
    if (trigger === "regenerate-message") {
      return toReadableStream(
        await this.api.chat.regenerate({ chatId }, options),
      );
    }
    const last = messages.at(-1);
    if (last === undefined || last.role !== "user") {
      throw new Error("送信するユーザー発話がありません");
    }
    const { model, effort } = this.settings();
    return toReadableStream(
      await this.api.chat.send(
        {
          chatId,
          message: { id: last.id, role: "user", parts: last.parts },
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
        },
        options,
      ),
    );
  }

  async reconnectToStream({
    chatId,
    abortSignal,
  }: Parameters<
    ChatTransport<ChatUIMessage>["reconnectToStream"]
  >[0]): Promise<ReadableStream<UIMessageChunk> | null> {
    const iterable = await this.api.chat.reconnect(
      { chatId },
      abortSignal === undefined ? {} : { signal: abortSignal },
    );
    // 生成中でなければすぐ終わる。useChat には「再開するストリームは無い」と伝える
    const peeked = await peekIterable(iterable);
    return peeked === null ? null : toReadableStream(peeked);
  }
}
