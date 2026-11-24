import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Router } from "../../router.ts";

export type ApiClient = RouterClient<Router>;

/**
 * oRPC を呼ぶクライアント。起動時トークンを Authorization ヘッダに付ける。
 * token が undefined なのは、サーバがトークンを要求しない（CC_MANABU_NO_AUTH=1）ときだけ。
 */
export const createApiClient = (token: string | undefined): ApiClient =>
  createORPCClient(
    new RPCLink({
      url: `${window.location.origin}/orpc`,
      headers: (): Record<string, string> =>
        token === undefined ? {} : { authorization: `Bearer ${token}` },
    }),
  );
