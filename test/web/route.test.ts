import { describe, expect, test } from "bun:test";
import {
  chatIdFromPath,
  isArchivedTaskListPath,
  isTaskListPath,
  pathForChat,
  pathForTask,
  pathForWiki,
  taskIdFromPath,
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

  test("パスとタスク ID を相互に変換する", () => {
    expect(taskIdFromPath("/t/xyz")).toBe("xyz");
    // 「プロジェクト」だったころのリンクも開ける
    expect(taskIdFromPath("/p/xyz")).toBe("xyz");
    expect(taskIdFromPath("/c/xyz")).toBeUndefined();
    expect(chatIdFromPath("/t/xyz")).toBeUndefined();
    expect(pathForTask("xyz")).toBe("/t/xyz");
    expect(pathForTask(null)).toBe("/");
  });

  test("Wiki のパス", () => {
    expect(wikiFromPath("/t/xyz/wiki")).toEqual({ taskId: "xyz" });
    expect(wikiFromPath("/p/xyz/wiki")).toEqual({ taskId: "xyz" });
    expect(wikiFromPath("/t/xyz/wiki/pg1")).toEqual({
      taskId: "xyz",
      pageId: "pg1",
    });
    expect(wikiFromPath("/t/xyz")).toBeUndefined();
    expect(taskIdFromPath("/t/xyz/wiki")).toBeUndefined();
    expect(pathForWiki("xyz")).toBe("/t/xyz/wiki");
    expect(pathForWiki("xyz", "pg1")).toBe("/t/xyz/wiki/pg1");
  });

  test("タスク一覧のパス", () => {
    expect(isTaskListPath("/tasks")).toBe(true);
    expect(isTaskListPath("/tasks/")).toBe(true);
    expect(isTaskListPath("/projects")).toBe(true);
    expect(isTaskListPath("/t/x")).toBe(false);
    expect(isTaskListPath("/tasks/archived")).toBe(false);
    expect(isArchivedTaskListPath("/tasks/archived")).toBe(true);
    expect(isArchivedTaskListPath("/tasks/archived/")).toBe(true);
    expect(isArchivedTaskListPath("/tasks")).toBe(false);
  });
});
