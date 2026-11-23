import { describe, expect, test } from "bun:test";
import {
  chatIdFromPath,
  pathForChat,
  pathForProject,
  pathForWiki,
  projectIdFromPath,
  wikiFromPath,
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

  test("Wiki のパス", () => {
    expect(wikiFromPath("/p/xyz/wiki")).toEqual({ projectId: "xyz" });
    expect(wikiFromPath("/p/xyz/wiki/pg1")).toEqual({
      projectId: "xyz",
      pageId: "pg1",
    });
    expect(wikiFromPath("/p/xyz")).toBeUndefined();
    expect(projectIdFromPath("/p/xyz/wiki")).toBeUndefined();
    expect(pathForWiki("xyz")).toBe("/p/xyz/wiki");
    expect(pathForWiki("xyz", "pg1")).toBe("/p/xyz/wiki/pg1");
  });
});
