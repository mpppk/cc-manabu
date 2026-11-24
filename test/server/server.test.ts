import { afterEach, describe, expect, test } from "bun:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { Result } from "@praha/byethrow";
import { type Router, router } from "../../src/router.ts";
import { type RunningServer, startServer } from "../../src/server/server.ts";
import { createTestContext } from "../helpers/context.ts";

const TOKEN = "test-token";
let server: RunningServer | undefined;

const start = () => {
  const result = startServer({
    port: 0,
    token: TOKEN,
    router,
    context: createTestContext().context,
  });
  if (Result.isFailure(result)) throw result.error;
  server = result.value;
  return server;
};

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe("startServer", () => {
  test("127.0.0.1 で起動し、トークン付きの URL を返す", () => {
    const s = start();
    expect(s.port).toBeGreaterThan(0);
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/#token=${TOKEN}`);
  });

  test("正しいトークンなら oRPC を呼べる", async () => {
    const s = start();
    const client: RouterClient<Router> = createORPCClient(
      new RPCLink({
        url: `http://127.0.0.1:${s.port}/orpc`,
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(await client.system.ping()).toMatchObject({ ok: true });
  });

  test("トークンが無ければ 401", async () => {
    const s = start();
    const response = await fetch(
      `http://127.0.0.1:${s.port}/orpc/system/ping`,
      { method: "POST" },
    );
    expect(response.status).toBe(401);
  });

  test("別オリジンからのリクエストは 403", async () => {
    const s = start();
    const response = await fetch(
      `http://127.0.0.1:${s.port}/orpc/system/ping`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          origin: "https://evil.example.com",
        },
      },
    );
    expect(response.status).toBe(403);
  });

  test("SPA はトークンなしで返す", async () => {
    const s = start();
    const response = await fetch(`http://127.0.0.1:${s.port}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("マニフェストとアイコンを公開し、アプリの起動 URL にトークンを入れない", async () => {
    const s = start();
    const response = await fetch(new URL("/manifest.webmanifest", s.url));
    expect(response.headers.get("content-type")).toBe(
      "application/manifest+json",
    );
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    for (const size of [192, 512]) {
      const icon = await fetch(new URL(`/pwa/icon-${size}.png`, s.url));
      expect(icon.headers.get("content-type")).toBe("image/png");
      const bytes = new DataView(await icon.arrayBuffer());
      expect(bytes.getUint32(0)).toBe(0x89504e47);
      expect(bytes.getUint32(16)).toBe(size);
      expect(bytes.getUint32(20)).toBe(size);
    }
  });

  test("使用中のポートなら PortInUseError", () => {
    const s = start();
    const result = startServer({
      port: s.port,
      token: TOKEN,
      router,
      context: createTestContext().context,
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.error.name).toBe("PortInUseError");
    }
  });
});
