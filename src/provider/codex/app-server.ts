/**
 * ローカルの Codex App Server（`codex app-server`）との JSON-RPC（#265）。
 * 標準入出力で、1 行に 1 つの JSON を送り合う（`jsonrpc` フィールドは付けない）。
 *
 * - request: id を付けて送り、同じ id の応答を待つ
 * - notification: サーバーからの通知（item/agentMessage/delta など）
 * - server request: サーバーからの問い合わせ（コマンド実行の承認など）。応答を返す
 */
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

export class CodexAppServerError extends ErrorFactory({
  name: "CodexAppServerError",
  message: ({ detail }) => detail,
  fields: ErrorFactory.fields<{ detail: string }>(),
}) {}

/** App Server のプロセス（テストでは差し替える）。 */
export type AppServerProcess = {
  write: (line: string) => void;
  /** 標準出力。1 行に 1 つの JSON。 */
  stdout: ReadableStream<Uint8Array>;
  /** 終わったら解決する。標準エラーの内容を返す（起動に失敗したときの説明に使う）。 */
  exited: Promise<{ code: number | null; stderr: string }>;
  kill: () => void;
};

export type SpawnAppServer = () => AppServerProcess;

/** PATH 上の（または指定した）`codex` で App Server を起動する。 */
export const spawnCodexAppServer =
  (executable = "codex"): SpawnAppServer =>
  () => {
    const child = Bun.spawn([executable, "app-server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      write: (line) => {
        child.stdin.write(line);
        child.stdin.flush();
      },
      stdout: child.stdout,
      exited: (async () => {
        const [stderr, code] = await Promise.all([
          new Response(child.stderr).text().catch(() => ""),
          child.exited,
        ]);
        return { code, stderr };
      })(),
      kill: () => {
        try {
          child.stdin.end();
        } catch {
          // すでに閉じている
        }
        child.kill();
      },
    };
  };

type Pending = {
  resolve: (value: Result.Result<unknown, CodexAppServerError>) => void;
};

export type ServerRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

/** App Server との接続。connect で起動し、close で止める。 */
export class CodexAppServer {
  private readonly process: AppServerProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private notificationHandler: (method: string, params: unknown) => void =
    () => {};
  private serverRequestHandler: ServerRequestHandler = async () => {
    throw new Error("unsupported");
  };
  private closed = false;
  /** プロセスが終わったときの説明（途中で落ちたときに使う）。 */
  private exitDetail: string | undefined;

  constructor(process: AppServerProcess) {
    this.process = process;
    void this.readLoop();
    void process.exited.then(({ code, stderr }) => {
      this.exitDetail = stderr.trim() || `終了コード ${code}`;
      this.failAll(
        `Codex App Server が終了しました（${this.exitDetail.slice(0, 300)}）。`,
      );
    });
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /** 問い合わせを送り、応答を待つ。エラー応答や接続の終了は失敗にする。 */
  request<T>(
    method: string,
    params: unknown,
  ): Result.ResultAsync<T, CodexAppServerError> {
    if (this.closed) {
      return Promise.resolve(
        Result.fail(
          new CodexAppServerError({
            detail: "Codex App Server との接続は閉じています。",
          }),
        ),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, {
        resolve: resolve as Pending["resolve"],
      });
      this.send({ id, method, params });
    });
  }

  /** 通知を送る（initialized など）。 */
  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  close(): void {
    if (this.closed) return;
    this.failAll("Codex App Server との接続を閉じました。");
    this.closed = true;
    this.process.kill();
  }

  private send(message: unknown): void {
    try {
      this.process.write(`${JSON.stringify(message)}\n`);
    } catch (cause) {
      this.failAll("Codex App Server に書き込めませんでした。", cause);
    }
  }

  private failAll(detail: string, cause?: unknown): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.resolve(
        Result.fail(
          new CodexAppServerError(
            cause === undefined ? { detail } : { detail, cause },
          ),
        ),
      );
    }
  }

  private async readLoop(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (
          let newline = buffer.indexOf("\n");
          newline >= 0;
          newline = buffer.indexOf("\n")
        ) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line !== "") this.dispatch(line);
        }
      }
    } catch {
      // 読めなくなったら、exited で後始末する
    }
  }

  private dispatch(line: string): void {
    let message: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      const { id, method, params } = message;
      void this.serverRequestHandler(method, params).then(
        (result) => this.send({ id, result }),
        (error: unknown) =>
          this.send({
            id,
            error: {
              code: -32601,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
      return;
    }
    if (message.method !== undefined) {
      try {
        this.notificationHandler(message.method, message.params);
      } catch {
        // 通知の処理の失敗で、接続は止めない
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    pending.resolve(
      message.error === undefined
        ? Result.succeed(message.result)
        : Result.fail(
            new CodexAppServerError({
              detail:
                message.error.message ?? "Codex App Server のエラーです。",
            }),
          ),
    );
  }
}

/** 接続して initialize を済ませる。 */
export const connectCodex = async (
  spawn: SpawnAppServer,
  clientVersion: string,
): Promise<Result.Result<CodexAppServer, CodexAppServerError>> => {
  let server: CodexAppServer;
  try {
    server = new CodexAppServer(spawn());
  } catch (cause) {
    return Result.fail(
      new CodexAppServerError({
        detail:
          "Codex を起動できませんでした。Codex CLI をインストールし、PATH に `codex` があるか確認してください。",
        cause,
      }),
    );
  }
  const initialized = await server.request("initialize", {
    clientInfo: { name: "monet", title: "Monet", version: clientVersion },
    capabilities: null,
  });
  if (Result.isFailure(initialized)) {
    server.close();
    return initialized;
  }
  server.notify("initialized");
  return Result.succeed(server);
};
