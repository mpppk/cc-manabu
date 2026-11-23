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
  /** SPA（#34 で React に置き換える）。 */
  index?: Response | (() => Response);
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
            "/*": () => {
              const index = options.index ?? placeholderIndex;
              return typeof index === "function" ? index() : index.clone();
            },
          },
        }),
      catch: (error) =>
        error instanceof Error &&
        (error as { code?: string }).code === "EADDRINUSE"
          ? new PortInUseError({ port: options.port, cause: error })
          : new ServerStartError({ cause: error }),
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
