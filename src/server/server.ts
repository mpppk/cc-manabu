import { RPCHandler } from "@orpc/server/fetch";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import type { Router, RouterContext } from "../router.ts";
import { accessErrorResponse, checkApiRequest } from "./access-control.ts";

export class PortInUseError extends ErrorFactory({
  name: "PortInUseError",
  message: (fields) =>
    `Port ${fields.port} is already in use. Set CC_MANABU_PORT to another port.`,
  fields: ErrorFactory.fields<{ port: number }>(),
}) {}

export class ServerStartError extends ErrorFactory({
  name: "ServerStartError",
  message: "Failed to start the server",
}) {}

export type StartServerOptions = {
  port: number;
  token: string;
  router: Router;
  context: RouterContext;
  /** SPA（src/web/index.html）。省略時は仮の HTML（テスト用）。 */
  index?: Bun.HTMLBundle;
  /** 開発時は HMR を有効にする。 */
  development?: boolean;
};

export type RunningServer = {
  port: number;
  /** トークン付きの URL。ブラウザで開く。 */
  url: string;
  stop: () => Promise<void>;
};

const placeholderIndex = () =>
  new Response(
    "<!doctype html><meta charset=utf-8><title>cc-manabu</title><p>cc-manabu の Web UI は準備中です。</p>",
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

/** 127.0.0.1 にのみ bind してサーバを起動する（開発計画 §2.6）。 */
export const startServer = (
  options: StartServerOptions,
): Result.Result<RunningServer, PortInUseError | ServerStartError> => {
  const handler = new RPCHandler(options.router);
  let actualPort = options.port;

  return Result.pipe(
    Result.try({
      try: () =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: options.port,
          // SSE / イベントストリームを切らない
          idleTimeout: 0,
          // development: false を明示すると、Bun は使用中のポートでもエラーにせず別のポートで起動してしまう。
          // 有効にするときだけ渡す。
          ...(options.development === true
            ? { development: { hmr: true } }
            : {}),
          routes: {
            "/orpc/*": async (request) => {
              const access = checkApiRequest(request, {
                port: actualPort,
                token: options.token,
              });
              if (Result.isFailure(access)) {
                return accessErrorResponse(access.error);
              }
              const { matched, response } = await handler.handle(request, {
                prefix: "/orpc",
                context: options.context,
              });
              return matched
                ? response
                : new Response("Not found", { status: 404 });
            },
            "/*": options.index ?? placeholderIndex,
          },
        }),
      catch: (error) =>
        error instanceof Error &&
        (error as { code?: string }).code === "EADDRINUSE"
          ? new PortInUseError({ port: options.port, cause: error })
          : new ServerStartError({ cause: error }),
    }),
    Result.andThen((server) => {
      // 念のため、指定したポートで起動できたかを確かめる
      if (options.port !== 0 && server.port !== options.port) {
        server.stop(true);
        return Result.fail(new PortInUseError({ port: options.port }));
      }
      return Result.succeed(server);
    }),
    Result.map((server) => {
      actualPort = server.port ?? options.port;
      return {
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}/#token=${options.token}`,
        stop: () => server.stop(true),
      };
    }),
  );
};

/** OS の既定ブラウザで URL を開く。失敗しても起動は続ける。 */
export const openBrowser = (url: string): void => {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // ブラウザを開けない環境では URL の表示だけにする
  }
};
