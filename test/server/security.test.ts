/**
 * セキュリティテスト（#33）: Bash などを実行できるサーバなので、アクセス制御と承認が破れないことを確かめる。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { Result } from "@praha/byethrow";
import { router } from "../../src/router.ts";
import { type RunningServer, startServer } from "../../src/server/server.ts";
import { createTestContext } from "../helpers/context.ts";

const TOKEN = "security-test-token";
let server: RunningServer;
let base: string;

beforeAll(() => {
  const started = startServer({
    port: 0,
    token: TOKEN,
    router,
    context: createTestContext().context,
  });
  if (Result.isFailure(started)) throw started.error;
  server = started.value;
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop();
});

/** oRPC の RPC プロトコルでの呼び出し（POST + JSON）。 */
const call = (
  path: string,
  headers: Record<string, string>,
  input: unknown = {},
) =>
  fetch(`${base}/orpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ json: input }),
  });

const auth = { authorization: `Bearer ${TOKEN}` };

const PROCEDURES: [string, unknown][] = [
  ["system/status", {}],
  ["chats/list", {}],
  ["chats/create", {}],
  ["chat/send", { chatId: "x", message: { id: "m", role: "user", parts: [] } }],
  ["chat/stop", { chatId: "x" }],
  ["approvals/respond", { chatId: "x", approvalId: "y", behavior: "allow" }],
];

describe("トークン", () => {
  test.each(PROCEDURES)("%s はトークンなしで 401", async (path, input) => {
    expect((await call(path, {}, input)).status).toBe(401);
  });

  test.each(PROCEDURES)("%s は誤ったトークンで 401", async (path, input) => {
    expect(
      (await call(path, { authorization: "Bearer wrong" }, input)).status,
    ).toBe(401);
  });

  test("クエリ文字列や Cookie のトークンは受け付けない", async () => {
    const response = await fetch(`${base}/orpc/chats/list?token=${TOKEN}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `token=${TOKEN}`,
      },
      body: JSON.stringify({ json: {} }),
    });
    expect(response.status).toBe(401);
  });

  test("Web UI にはトークンが要ると答える", async () => {
    const response = await fetch(`${base}/auth-mode`);
    expect(await response.json()).toEqual({ tokenRequired: true });
  });

  test("ブラウザで開く URL では、トークンをサーバに送られない fragment に入れる", () => {
    const url = new URL(server.url);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#token=${TOKEN}`);
  });
});

describe("Origin（CSRF）", () => {
  test.each([
    "https://evil.example.com",
    "http://localhost.evil.example.com",
    "null",
  ])("Origin: %s は正しいトークンがあっても 403", async (origin) => {
    expect((await call("chats/list", { ...auth, origin })).status).toBe(403);
  });

  test("自分自身のオリジンは通す", async () => {
    expect((await call("chats/list", { ...auth, origin: base })).status).toBe(
      200,
    );
  });

  test("CORS を許可するヘッダを返さない（プリフライトも通らない）", async () => {
    const preflight = await fetch(`${base}/orpc/chats/list`, {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const response = await call("chats/list", auth);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("Host（DNS rebinding）", () => {
  test("Host が攻撃者のドメインなら、正しいトークンがあっても 403", async () => {
    const response = await call("chats/list", {
      ...auth,
      host: `evil.example.com:${server.port}`,
    });
    expect(response.status).toBe(403);
  });
});

describe("トークンを要求しないモード（MONET_NO_AUTH=1）", () => {
  let open: RunningServer;
  let openBase: string;

  beforeAll(() => {
    const started = startServer({
      port: 0,
      token: null,
      router,
      context: createTestContext().context,
    });
    if (Result.isFailure(started)) throw started.error;
    open = started.value;
    openBase = `http://127.0.0.1:${open.port}`;
  });

  afterAll(async () => {
    await open.stop();
  });

  const callOpen = (headers: Record<string, string>) =>
    fetch(`${openBase}/orpc/chats/list`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ json: {} }),
    });

  test("トークンなしで API を呼べる", async () => {
    expect((await callOpen({})).status).toBe(200);
    expect((await callOpen({ origin: openBase })).status).toBe(200);
  });

  test("Origin と Host は検証する", async () => {
    expect(
      (await callOpen({ origin: "https://evil.example.com" })).status,
    ).toBe(403);
    expect(
      (await callOpen({ host: `evil.example.com:${open.port}` })).status,
    ).toBe(403);
  });

  test("Web UI にはトークンが要らないと答え、URL にトークンを付けない", async () => {
    const response = await fetch(`${openBase}/auth-mode`);
    expect(await response.json()).toEqual({ tokenRequired: false });
    expect(new URL(open.url).hash).toBe("");
  });

  test("問い合わせでも Host を検証する", async () => {
    const response = await fetch(`${openBase}/auth-mode`, {
      headers: { host: `evil.example.com:${open.port}` },
    });
    expect(response.status).toBe(403);
  });
});

describe("待ち受けアドレス", () => {
  const externalAddress = Object.values(networkInterfaces())
    .flat()
    .find((info) => info?.family === "IPv4" && !info.internal)?.address;

  test.skipIf(externalAddress === undefined)(
    "127.0.0.1 以外のアドレスからは接続できない",
    async () => {
      expect(
        fetch(`http://${externalAddress}:${server.port}/`, {
          signal: AbortSignal.timeout(2000),
        }),
      ).rejects.toThrow();
    },
  );
});

describe("承認", () => {
  test("存在しない承認 ID には答えられない", async () => {
    const response = await call("approvals/respond", auth, {
      chatId: "x",
      approvalId: "not-exists",
      behavior: "allow",
    });
    expect(response.status).toBe(404);
  });
});
