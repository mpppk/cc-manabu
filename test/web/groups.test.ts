import { expect, test } from "bun:test";
import type { ChatDto } from "../../src/router.ts";
import {
  branchLabel,
  groupChats,
  listedChats,
} from "../../src/web/lib/groups.ts";

const chat = (overrides: Partial<ChatDto> & { id: string }): ChatDto => ({
  groupId: overrides.id,
  parentId: null,
  forkMessageId: null,
  inheritedCount: 0,
  branchTitle: "",
  lastSelectedAt: null,
  archivedAt: null,
  taskId: null,
  wikiPageId: null,
  title: "t",
  agent: "claude-code",
  model: "default",
  effort: null,
  cwd: "/w",
  status: "idle",
  createdAt: new Date(1000),
  updatedAt: new Date(1000),
  hasSession: true,
  ...overrides,
});

test("会話をスレッドごとにまとめ、最後に開いた会話を開く", () => {
  const root = chat({ id: "r", createdAt: new Date(1) });
  const b1 = chat({
    id: "b1",
    groupId: "r",
    parentId: "r",
    branchTitle: "非同期",
    createdAt: new Date(2),
    lastSelectedAt: new Date(50),
  });
  const b2 = chat({
    id: "b2",
    groupId: "r",
    parentId: "b1",
    createdAt: new Date(3),
    lastSelectedAt: new Date(10),
    status: "running",
  });
  const other = chat({ id: "o" });
  const groups = groupChats([b2, other, root, b1]);
  expect(groups.map((g) => g.groupId)).toEqual(["r", "o"]);
  expect(groups[0]?.branches.map((c) => c.id)).toEqual(["r", "b1", "b2"]);
  expect(groups[0]?.primary.id).toBe("b1");
  expect(groups[0]?.status).toBe("running");
  expect(groups[1]?.primary.id).toBe("o");
});

test("一度も選んでいなければ元の会話を開く", () => {
  const root = chat({ id: "r" });
  const b1 = chat({ id: "b1", groupId: "r", parentId: "r" });
  expect(groupChats([b1, root])[0]?.primary.id).toBe("r");
});

test("branchLabel", () => {
  expect(branchLabel(chat({ id: "r" }))).toBe("元の会話");
  expect(
    branchLabel(chat({ id: "b", parentId: "r", branchTitle: "非同期" })),
  ).toBe("非同期");
});

test("まだ何も送っていない会話は、開いているときだけ一覧に出す", () => {
  const sent = chat({ id: "sent" });
  const blank = chat({ id: "blank", title: "", hasSession: false });
  const renamed = chat({ id: "renamed", hasSession: false });
  const sending = chat({
    id: "sending",
    title: "",
    hasSession: false,
    status: "running",
  });
  const all = [sent, blank, renamed, sending];
  expect(listedChats(all, undefined).map((c) => c.id)).toEqual([
    "sent",
    "renamed",
    "sending",
  ]);
  expect(listedChats(all, "blank").map((c) => c.id)).toEqual([
    "sent",
    "blank",
    "renamed",
    "sending",
  ]);
});
