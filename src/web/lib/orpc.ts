import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Router } from "../../router.ts";

export type ApiClient = RouterClient<Router>;

/** 起動時トークンを Authorization ヘッダに付けて oRPC を呼ぶクライアント。 */
export const createApiClient = (token: string): ApiClient =>
  createORPCClient(
    new RPCLink({
      url: `${window.location.origin}/orpc`,
      headers: () => ({ authorization: `Bearer ${token}` }),
    }),
  );
