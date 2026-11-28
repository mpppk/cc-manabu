import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { ChatUIMessage } from "../../src/chat/chat-service.ts";
import type { ChatDto } from "../../src/router.ts";
import { BranchFromHere } from "../../src/web/components/branch-menu.tsx";
import {
  type BranchPoint,
  branchPointsOf,
  snippetOf,
} from "../../src/web/lib/branch-points.ts";

const chatDto = (id: string, title: string): ChatDto => ({
  id,
  groupId: "g",
  parentId: "root",
  forkMessageId: null,
  inheritedCount: 0,
  branchTitle: title,
  lastSelectedAt: null,
  archivedAt: null,
  taskId: null,
  wikiPageId: null,
  title,
  model: "sonnet",
  effort: null,
  cwd: "/w",
  status: "idle",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  hasSession: true,
});

const answer = (id: string, text: string, branchable = true): ChatUIMessage =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    ...(branchable
      ? { metadata: { claudeCode: { lastAssistantUuid: `uuid-${id}` } } }
      : {}),
  }) as ChatUIMessage;

const question = (id: string): ChatUIMessage =>
  ({
    id,
    role: "user",
    parts: [{ type: "text", text: "質問" }],
  }) as ChatUIMessage;

describe("branchPointsOf（#242）", () => {
  test("同じターンの複数の回答は、既存の分岐と新規作成の起点をそれぞれの回答に対応させる", () => {
    const forks: Record<string, ChatDto[]> = {
      a1: [chatDto("b1", "一つ目から")],
      a2: [chatDto("b2", "二つ目から"), chatDto("b3", "二つ目から 2")],
    };
    const created: string[] = [];
    const points = branchPointsOf(
      [
        question("q"),
        answer("a1", "最初の回答"),
        answer("a2", "二つ目の回答"),
        // 分岐元の位置が分からず、分岐も無い回答は起点にしない
        answer("a3", "途中の回答", false),
      ],
      {
        forksOf: (id) => forks[id] ?? [],
        quoted: (id) => id === "a2",
        onCreate: (id) => created.push(id),
      },
    );
    expect(points.map((p) => p.messageId)).toEqual(["a1", "a2"]);
    expect(points.map((p) => p.label)).toEqual([
      "回答 1「最初の回答」",
      "回答 2「二つ目の回答」",
    ]);
    expect(points.map((p) => p.forks.map((c) => c.id))).toEqual([
      ["b1"],
      ["b2", "b3"],
    ]);
    expect(points.map((p) => p.quoted)).toEqual([false, true]);
    points[1]?.onCreate?.();
    points[0]?.onCreate?.();
    expect(created).toEqual(["a2", "a1"]);
  });

  test("分岐元の位置が分からない回答でも、分岐があれば開ける（新規作成はできない）", () => {
    const [point] = branchPointsOf([answer("a", "古い回答", false)], {
      forksOf: () => [chatDto("b", "分岐")],
      quoted: () => false,
      onCreate: () => {},
    });
    expect(point?.forks).toHaveLength(1);
    expect(point?.onCreate).toBeUndefined();
  });

  test("生成中など新しい分岐を作れないときは、新規作成の起点を持たない", () => {
    const [point] = branchPointsOf([answer("a", "回答")], {
      forksOf: () => [],
      quoted: () => false,
      onCreate: undefined,
    });
    expect(point?.onCreate).toBeUndefined();
  });

  test("書き出しは長ければ省略し、本文が無ければ空", () => {
    expect(snippetOf(answer("a", "あいうえおかきくけこ"), 5)).toBe(
      "「あいうえお…」",
    );
    expect(snippetOf(answer("a", "  "), 5)).toBe("");
  });
});

describe("BranchFromHere（#242）", () => {
  const props = {
    current: chatDto("root", "元の会話"),
    branches: [],
    unread: new Set<string>(),
    disabled: false,
    onSelect: () => {},
  };
  const point = (forks: ChatDto[], creatable = true): BranchPoint => ({
    messageId: "a",
    label: "回答 1",
    forks,
    onCreate: creatable ? () => {} : undefined,
    quoted: false,
  });

  test("分岐が無ければ、メニューを挟まない「ここから分岐」", () => {
    const html = renderToString(
      <BranchFromHere {...props} points={[point([])]} />,
    );
    expect(html).toContain("ここから分岐");
    expect(html).not.toContain("aria-haspopup");
  });

  test("分岐があれば、数を出してメニューを開く", () => {
    const html = renderToString(
      <BranchFromHere
        {...props}
        points={[point([chatDto("b1", "x"), chatDto("b2", "y")])]}
      />,
    );
    expect(html).toContain("ここから分岐");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('data-fork-count="2"');
  });

  test("分岐も無く新しく作れもしなければ出さない", () => {
    expect(
      renderToString(<BranchFromHere {...props} points={[point([], false)]} />),
    ).toBe("");
  });
});
