import { describe, expect, test } from "bun:test";
import { takeToken } from "../../src/web/lib/token.ts";

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
