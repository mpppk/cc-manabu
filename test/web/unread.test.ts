import { describe, expect, test } from "bun:test";
import { nextUnread, parseUnread } from "../../src/web/lib/unread.ts";

type Status = "idle" | "running" | "awaiting_approval" | "error";
const chat = (id: string, status: Status) => ({ id, status });
const statuses = (entries: [string, Status][]) => new Map(entries);

describe("nextUnread", () => {
  test("開いていない会話が回答を終えたら印を付ける（エラー・承認待ちからも）", () => {
    const next = nextUnread(
      new Set(),
      statuses([
        ["a", "running"],
        ["b", "awaiting_approval"],
        ["c", "running"],
        ["d", "idle"],
      ]),
      [
        chat("a", "idle"),
        chat("b", "error"),
        chat("c", "running"),
        chat("d", "idle"),
      ],
      new Set(),
    );
    expect([...next].sort()).toEqual(["a", "b"]);
  });

  test("承認待ちから回答の続きに戻っただけでは付けない", () => {
    expect(
      nextUnread(
        new Set(),
        statuses([["a", "awaiting_approval"]]),
        [chat("a", "running")],
        new Set(),
      ),
    ).toEqual(new Set());
  });

  test("開いている会話には付けず、開いたら外す", () => {
    const next = nextUnread(
      new Set(["b"]),
      statuses([["a", "running"]]),
      [chat("a", "idle"), chat("b", "idle")],
      new Set(["a", "b"]),
    );
    expect(next).toEqual(new Set());
  });

  test("前の状態を知らない会話（読み込んだ直後）には付けず、無くなった会話からは外す", () => {
    const next = nextUnread(
      new Set(["gone", "kept"]),
      new Map(),
      [chat("kept", "idle"), chat("new", "idle")],
      new Set(),
    );
    expect(next).toEqual(new Set(["kept"]));
  });
});

test("parseUnread は壊れた値を空として読む", () => {
  expect(parseUnread(JSON.stringify(["a", 1, "b"]))).toEqual(
    new Set(["a", "b"]),
  );
  expect(parseUnread("{")).toEqual(new Set());
  expect(parseUnread('{"a":1}')).toEqual(new Set());
  expect(parseUnread(null)).toEqual(new Set());
});
