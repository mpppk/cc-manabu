import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import type { UIMessageChunk } from "ai";
import { ChatRunner } from "./chat-runner.ts";

export class ChatAlreadyRunningError extends ErrorFactory({
  name: "ChatAlreadyRunningError",
  message: (fields) => `Chat is already generating: ${fields.chatId}`,
  fields: ErrorFactory.fields<{ chatId: string }>(),
}) {}

export class TooManyRunnersError extends ErrorFactory({
  name: "TooManyRunnersError",
  message: (fields) =>
    `Too many chats are generating at the same time (limit: ${fields.limit}).`,
  fields: ErrorFactory.fields<{ limit: number }>(),
}) {}

export const DEFAULT_MAX_CONCURRENT = 3;

/** 生成中の ChatRunner を会話ごとに管理する。同時に生成できる数に上限を設ける。 */
export class RunnerRegistry {
  private readonly runners = new Map<string, ChatRunner>();
  readonly maxConcurrent: number;

  constructor(options: { maxConcurrent?: number } = {}) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  start(
    chatId: string,
    start: (signal: AbortSignal) => ReadableStream<UIMessageChunk>,
  ): Result.Result<ChatRunner, ChatAlreadyRunningError | TooManyRunnersError> {
    if (this.runners.has(chatId)) {
      return Result.fail(new ChatAlreadyRunningError({ chatId }));
    }
    if (this.runners.size >= this.maxConcurrent) {
      return Result.fail(
        new TooManyRunnersError({ limit: this.maxConcurrent }),
      );
    }
    const runner = new ChatRunner(chatId, start);
    this.runners.set(chatId, runner);
    runner.done.then(() => {
      if (this.runners.get(chatId) === runner) {
        this.runners.delete(chatId);
      }
    });
    return Result.succeed(runner);
  }

  get(chatId: string): ChatRunner | undefined {
    return this.runners.get(chatId);
  }

  /** 生成中なら止めて true を返す。 */
  stop(chatId: string): boolean {
    const runner = this.runners.get(chatId);
    runner?.stop();
    return runner !== undefined;
  }

  /** 生成中の会話 ID。 */
  runningChatIds(): string[] {
    return [...this.runners.keys()];
  }

  /** サーバ終了時: すべて止めて、終わるのを待つ。 */
  async stopAll(): Promise<void> {
    const runners = [...this.runners.values()];
    for (const runner of runners) {
      runner.stop();
    }
    await Promise.all(runners.map((runner) => runner.done));
  }
}
