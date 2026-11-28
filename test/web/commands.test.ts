import { describe, expect, test } from "bun:test";
import {
  filterCommands,
  type PaletteCommand,
} from "../../src/web/lib/commands.ts";

const command = (label: string, keywords: string[]): PaletteCommand => ({
  id: label,
  label,
  keywords,
  run: () => {},
});

const commands = [
  command("新しいスレッド", ["会話", "new", "thread"]),
  command("スレッドを検索", ["探す", "search"]),
  command("タスク一覧", ["カンバン", "tasks"]),
  command("新しいタスク", ["作成", "new", "task"]),
];
const labels = (query: string) =>
  filterCommands(commands, query).map((c) => c.label);

describe("filterCommands（#243）", () => {
  test("空ならすべてを元の順で返す", () => {
    expect(labels("  ")).toEqual(commands.map((c) => c.label));
  });

  test("操作名で絞り込む", () => {
    expect(labels("タスク")).toEqual(["タスク一覧", "新しいタスク"]);
    expect(labels("検索")).toEqual(["スレッドを検索"]);
  });

  test("別の言い方にも当て、操作名に当たるものを先にする", () => {
    expect(labels("カンバン")).toEqual(["タスク一覧"]);
    expect(labels("new")).toEqual(["新しいスレッド", "新しいタスク"]);
    expect(labels("新しい")).toEqual(["新しいスレッド", "新しいタスク"]);
  });

  test("空白で区切った語句はすべてを含むものだけ。大文字・全角も同じに扱う", () => {
    expect(labels("新しい タスク")).toEqual(["新しいタスク"]);
    expect(labels("ＴＡＳＫＳ")).toEqual(["タスク一覧"]);
    expect(labels("存在しない")).toEqual([]);
  });
});
