import type { UIMessageChunk } from "ai";

export type RunnerState = "running" | "finished";

/**
 * 1 つの会話の 1 回の生成を、HTTP 接続から切り離して進める（開発計画 §2.3）。
 *
 * - 生成元の UIMessageChunk をすべてバッファに積み、購読者に配る
 * - 購読者が全員いなくなっても生成は続ける。止めるのは stop() だけ
 * - 途中から購読した場合は、バッファを先頭から再送してから続きを流す
 */
export class ChatRunner {
  readonly chatId: string;
  private readonly chunks: UIMessageChunk[] = [];
  private readonly abortController = new AbortController();
  private stateValue: RunnerState = "running";
  private wake: () => void = () => {};
  private changed: Promise<void>;
  /** 生成が終わる（成功・中断・エラー）と解決する。 */
  readonly done: Promise<void>;

  constructor(
    chatId: string,
    start: (signal: AbortSignal) => ReadableStream<UIMessageChunk>,
  ) {
    this.chatId = chatId;
    this.changed = this.nextChange();
    this.done = this.consume(start);
  }

  get state(): RunnerState {
    return this.stateValue;
  }

  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

  /** これまでに届いたチャンク（コピー）。 */
  snapshot(): UIMessageChunk[] {
    return [...this.chunks];
  }

  /** 生成を止める。生成元には AbortSignal で伝わる。 */
  stop(reason?: unknown): void {
    this.abortController.abort(reason);
  }

  /**
   * バッファの先頭から流し、その後は新しいチャンクを流す。生成が終わると終了する。
   * signal を abort すると、この購読だけが終わる（生成は止まらない）。
   */
  async *subscribe(signal?: AbortSignal): AsyncGenerator<UIMessageChunk> {
    let index = 0;
    while (signal?.aborted !== true) {
      while (index < this.chunks.length) {
        const chunk = this.chunks[index];
        index += 1;
        if (chunk !== undefined) {
          yield chunk;
        }
      }
      if (this.stateValue === "finished") {
        return;
      }
      await this.waitForChange(signal);
    }
  }

  /** subscribe() を ReadableStream として返す。 */
  toStream(signal?: AbortSignal): ReadableStream<UIMessageChunk> {
    const iterator = this.subscribe(signal);
    return new ReadableStream<UIMessageChunk>({
      pull: async (controller) => {
        const { done, value } = await iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel: async () => {
        await iterator.return(undefined);
      },
    });
  }

  private nextChange(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.changed = this.nextChange();
    wake();
  }

  private waitForChange(signal?: AbortSignal): Promise<void> {
    if (signal === undefined) {
      return this.changed;
    }
    if (signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      this.changed.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  private async consume(
    start: (signal: AbortSignal) => ReadableStream<UIMessageChunk>,
  ): Promise<void> {
    try {
      const reader = start(this.abortController.signal).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        // AI SDK は同じ id の data パーツを受け取ると、先に流したチャンクのオブジェクトを書き換える。
        // 再送時に当時の内容を流せるよう、受け取った時点で複製しておく。
        this.chunks.push(structuredClone(value));
        this.notify();
      }
    } catch (error) {
      // 生成元が例外で終わった場合も、購読者には error チャンクとして伝える
      this.chunks.push({
        type: "error",
        errorText: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.stateValue = "finished";
      this.notify();
    }
  }
}
