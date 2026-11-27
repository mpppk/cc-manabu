import { describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import type { UIMessageChunk } from "ai";
import { ChatRunner } from "../../src/chat/chat-runner.ts";
import { RunnerRegistry } from "../../src/chat/runner-registry.ts";

/** 外からチャンクを流せる生成元。 */
const controllableSource = () => {
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  let signal: AbortSignal | undefined;
  const start = (s: AbortSignal) => {
    signal = s;
    return new ReadableStream<UIMessageChunk>({
      start: (c) => {
        controller = c;
        s.addEventListener("abort", () => c.close(), { once: true });
      },
    });
  };
  return {
    start,
    push: (chunk: UIMessageChunk) => controller.enqueue(chunk),
    close: () => controller.close(),
    fail: (error: Error) => controller.error(error),
    get signal() {
      return signal;
    },
  };
};

const text = (delta: string): UIMessageChunk => ({
  type: "text-delta",
  id: "t",
  delta,
});

const collect = async (iterable: AsyncIterable<UIMessageChunk>) => {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ChatRunner", () => {
  test("購読者にチャンクを流し、生成が終わると購読も終わる", async () => {
    const source = controllableSource();
    const runner = new ChatRunner("c1", source.start);
    const received = collect(runner.subscribe());
    source.push(text("a"));
    source.push(text("b"));
    source.close();
    expect(await received).toEqual([text("a"), text("b")]);
    await runner.done;
    expect(runner.state).toBe("finished");
  });

  test("途中から購読すると、バッファを先頭から再送してから続きを流す", async () => {
    const source = controllableSource();
    const runner = new ChatRunner("c1", source.start);
    source.push(text("a"));
    await tick();
    const late = collect(runner.subscribe());
    source.push(text("b"));
    source.close();
    expect(await late).toEqual([text("a"), text("b")]);
  });

  test("購読者が切断しても生成は続く", async () => {
    const source = controllableSource();
    const runner = new ChatRunner("c1", source.start);
    const disconnect = new AbortController();
    const first: UIMessageChunk[] = [];
    const reading = (async () => {
      for await (const chunk of runner.subscribe(disconnect.signal)) {
        first.push(chunk);
        disconnect.abort();
      }
    })();
    source.push(text("a"));
    await reading;
    source.push(text("b"));
    source.close();
    await runner.done;
    expect(first).toEqual([text("a")]);
    expect(source.signal?.aborted).toBe(false);
    expect(runner.snapshot()).toEqual([text("a"), text("b")]);
  });

  test("stop() で生成元に abort が伝わる", async () => {
    const source = controllableSource();
    const runner = new ChatRunner("c1", source.start);
    source.push(text("a"));
    runner.stop();
    await runner.done;
    expect(source.signal?.aborted).toBe(true);
    expect(runner.aborted).toBe(true);
    expect(runner.state).toBe("finished");
  });

  test("生成元が例外で終わったら error チャンクを流す", async () => {
    const source = controllableSource();
    const runner = new ChatRunner("c1", source.start);
    source.push(text("a"));
    source.fail(new Error("boom"));
    expect(await collect(runner.subscribe())).toEqual([
      text("a"),
      { type: "error", errorText: "boom" },
    ]);
  });

  test("toStream() は ReadableStream として読める", async () => {
    const source = controllableSource();
    const runner = new ChatRunner("c1", source.start);
    source.push(text("a"));
    source.close();
    expect(await collect(runner.toStream())).toEqual([text("a")]);
  });
});

describe("RunnerRegistry", () => {
  test("同じ会話は二重に開始できない", () => {
    const registry = new RunnerRegistry();
    registry.start("c1", controllableSource().start);
    const second = registry.start("c1", controllableSource().start);
    expect(Result.isFailure(second) && second.error.name).toBe(
      "ChatAlreadyRunningError",
    );
  });

  test("既定では 10 件まで同時に生成できる（#225）", () => {
    const registry = new RunnerRegistry();
    expect(registry.maxConcurrent).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(
        Result.isSuccess(registry.start(`c${i}`, controllableSource().start)),
      ).toBe(true);
    }
    const eleventh = registry.start("c10", controllableSource().start);
    expect(Result.isFailure(eleventh) && eleventh.error.name).toBe(
      "TooManyRunnersError",
    );
  });

  test("同時に生成できる数を超えたら TooManyRunnersError", () => {
    const registry = new RunnerRegistry({ maxConcurrent: 2 });
    registry.start("c1", controllableSource().start);
    registry.start("c2", controllableSource().start);
    const third = registry.start("c3", controllableSource().start);
    expect(Result.isFailure(third) && third.error.name).toBe(
      "TooManyRunnersError",
    );
    expect(registry.runningChatIds()).toEqual(["c1", "c2"]);
  });

  test("終わった Runner は一覧から消え、同じ会話をまた開始できる", async () => {
    const registry = new RunnerRegistry();
    const source = controllableSource();
    const started = registry.start("c1", source.start);
    if (Result.isFailure(started)) throw started.error;
    source.close();
    await started.value.done;
    expect(registry.get("c1")).toBeUndefined();
    expect(
      Result.isSuccess(registry.start("c1", controllableSource().start)),
    ).toBe(true);
  });

  test("stop と stopAll", async () => {
    const registry = new RunnerRegistry();
    const a = controllableSource();
    const b = controllableSource();
    registry.start("a", a.start);
    registry.start("b", b.start);
    expect(registry.stop("a")).toBe(true);
    expect(registry.stop("missing")).toBe(false);
    await registry.stopAll();
    expect(a.signal?.aborted).toBe(true);
    expect(b.signal?.aborted).toBe(true);
    expect(registry.runningChatIds()).toEqual([]);
  });
});

describe("ChatRunner のバッファ", () => {
  test("生成元が後からチャンクを書き換えても、バッファの内容は変わらない", async () => {
    const source = controllableSource();
    const runner = new ChatRunner("c1", source.start);
    const chunk = {
      type: "data-approval",
      id: "a1",
      data: { status: "pending" },
    } as UIMessageChunk;
    source.push(chunk);
    await tick();
    (chunk as { data: { status: string } }).data.status = "allowed";
    source.close();
    await runner.done;
    expect(runner.snapshot()).toEqual([
      { type: "data-approval", id: "a1", data: { status: "pending" } },
    ] as UIMessageChunk[]);
  });
});

describe("終了時の後始末", () => {
  test("購読が終わった時点で、レジストリから外れている", async () => {
    const registry = new RunnerRegistry();
    const source = controllableSource();
    const started = registry.start("c1", source.start);
    if (Result.isFailure(started)) throw started.error;
    const reading = collect(started.value.subscribe());
    source.close();
    await reading;
    // done を待たずに、すぐ次の生成を始められる
    expect(registry.get("c1")).toBeUndefined();
    expect(
      Result.isSuccess(registry.start("c1", controllableSource().start)),
    ).toBe(true);
  });

  test("終わったあとに登録した onFinish はすぐ呼ばれる", async () => {
    const source = controllableSource();
    const runner = new ChatRunner("c1", source.start);
    source.close();
    await runner.done;
    let called = false;
    runner.onFinish(() => {
      called = true;
    });
    expect(called).toBe(true);
  });
});
