import { describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import {
  checkApiRequest,
  generateToken,
} from "../../src/server/access-control.ts";

const PORT = 4321;
const TOKEN = "secret-token";

const request = (headers: Record<string, string>) =>
  new Request(`http://127.0.0.1:${PORT}/orpc/system/ping`, {
    method: "POST",
    headers,
  });

const errorName = (headers: Record<string, string>) => {
  const result = checkApiRequest(request(headers), {
    port: PORT,
    token: TOKEN,
  });
  return Result.isFailure(result) ? result.error.name : "ok";
};

describe("generateToken", () => {
  test("256bit の base64url で、毎回異なる", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });
});

describe("checkApiRequest", () => {
  const valid = {
    host: `127.0.0.1:${PORT}`,
    origin: `http://127.0.0.1:${PORT}`,
    authorization: `Bearer ${TOKEN}`,
  };

  test("正しいリクエストは通す", () => {
    expect(errorName(valid)).toBe("ok");
    expect(
      errorName({
        ...valid,
        host: `localhost:${PORT}`,
        origin: `http://localhost:${PORT}`,
      }),
    ).toBe("ok");
  });

  test("Origin が無い（ブラウザ以外）のは、トークンが正しければ通す", () => {
    const { origin: _, ...withoutOrigin } = valid;
    expect(errorName(withoutOrigin)).toBe("ok");
  });

  test.each([
    ["evil.example.com"],
    [`evil.example.com:${PORT}`],
    ["127.0.0.1:1"],
  ])("Host が %s なら拒否する（DNS rebinding）", (host) => {
    expect(errorName({ ...valid, host })).toBe("ForbiddenHostError");
  });

  test.each([
    ["https://evil.example.com"],
    [`http://127.0.0.1:${PORT + 1}`],
    ["null"],
  ])("Origin が %s なら拒否する（CSRF）", (origin) => {
    expect(errorName({ ...valid, origin })).toBe("ForbiddenOriginError");
  });

  test.each([
    [undefined],
    ["Bearer wrong"],
    [`Basic ${TOKEN}`],
    [`Bearer ${TOKEN}x`],
  ])("トークンが %s なら拒否する", (authorization) => {
    const { authorization: _, ...rest } = valid;
    expect(
      errorName(
        authorization === undefined ? rest : { ...rest, authorization },
      ),
    ).toBe("InvalidTokenError");
  });
});

describe("checkApiRequest（CC_MANABU_NO_AUTH=1: token が null）", () => {
  const noAuth = (headers: Record<string, string>) => {
    const result = checkApiRequest(request(headers), {
      port: PORT,
      token: null,
    });
    return Result.isFailure(result) ? result.error.name : "ok";
  };
  const local = {
    host: `127.0.0.1:${PORT}`,
    origin: `http://127.0.0.1:${PORT}`,
  };

  test("トークンが無くても通す", () => {
    expect(noAuth(local)).toBe("ok");
    expect(noAuth({ ...local, authorization: "Bearer anything" })).toBe("ok");
  });

  test("Host と Origin は検証する", () => {
    expect(noAuth({ ...local, host: "evil.example.com" })).toBe(
      "ForbiddenHostError",
    );
    expect(noAuth({ ...local, origin: "https://evil.example.com" })).toBe(
      "ForbiddenOriginError",
    );
  });
});
