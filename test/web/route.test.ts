import { describe, expect, test } from "bun:test";
import {
  chatIdFromPath,
  pathForChat,
  pathForProject,
  projectIdFromPath,
} from "../../src/web/lib/route.ts";

describe("route", () => {
  test("パスと会話 ID を相互に変換する", () => {
    expect(chatIdFromPath("/c/abc")).toBe("abc");
    expect(chatIdFromPath("/c/abc/")).toBe("abc");
    expect(chatIdFromPath("/")).toBeUndefined();
    expect(chatIdFromPath("/c/")).toBeUndefined();
    expect(pathForChat("abc")).toBe("/c/abc");
    expect(pathForChat(undefined)).toBe("/");
  });

  test("パスとプロジェクト ID を相互に変換する", () => {
    expect(projectIdFromPath("/p/xyz")).toBe("xyz");
    expect(projectIdFromPath("/c/xyz")).toBeUndefined();
    expect(chatIdFromPath("/p/xyz")).toBeUndefined();
    expect(pathForProject("xyz")).toBe("/p/xyz");
    expect(pathForProject(null)).toBe("/");
  });
});
