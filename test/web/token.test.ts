import { describe, expect, test } from "bun:test";
import { resolveAccess, takeToken } from "../../src/web/lib/token.ts";

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
};

describe("takeToken", () => {
  test("fragment のトークンを保存し、URL から消す", () => {
    const storage = memoryStorage();
    const replaced: string[] = [];
    const token = takeToken(
      { hash: "#token=abc", pathname: "/", search: "" },
      storage,
      (url) => replaced.push(url),
    );
    expect(token).toBe("abc");
    expect(replaced).toEqual(["/"]);
    // リロード後（fragment なし）は保存したものを使う
    expect(
      takeToken({ hash: "", pathname: "/", search: "" }, storage, () => {}),
    ).toBe("abc");
  });

  test("どこにも無ければ undefined", () => {
    expect(
      takeToken(
        { hash: "", pathname: "/", search: "" },
        memoryStorage(),
        () => {},
      ),
    ).toBeUndefined();
  });
});

describe("resolveAccess", () => {
  const never = async () => {
    throw new Error("問い合わせない");
  };

  test("トークンがあればサーバに問い合わせずに使う", async () => {
    expect(await resolveAccess("abc", never)).toEqual({
      kind: "token",
      token: "abc",
    });
  });

  test("トークンが無く、サーバが要求しないなら open", async () => {
    expect(
      await resolveAccess(undefined, async () => ({ tokenRequired: false })),
    ).toEqual({ kind: "open" });
  });

  test.each([
    ["要求する", async () => ({ tokenRequired: true })],
    ["応答が不正", async () => ({ tokenRequired: "false" })],
    ["応答が無い", async () => undefined],
    ["問い合わせに失敗", never],
  ])("トークンが無く、サーバが%sなら missing", async (_, fetchAuthMode) => {
    expect(await resolveAccess(undefined, fetchAuthMode)).toEqual({
      kind: "missing",
    });
  });
});
