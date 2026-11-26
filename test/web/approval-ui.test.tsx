import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { ApprovalData } from "../../src/chat/approval-broker.ts";
import { ApprovalCard } from "../../src/web/components/approval-card.tsx";
import { newlyAwaiting, titleFor } from "../../src/web/lib/notify.ts";

const approval: ApprovalData = {
  approvalId: "a1",
  toolName: "Bash",
  toolUseId: "t1",
  displayName: "Bash",
  description: "Create a file",
  input: { command: "touch a.txt" },
  status: "pending",
};

const noop = async () => {};

describe("ApprovalCard", () => {
  test("pending なら内容と許可・拒否ボタンを出す", () => {
    const html = renderToString(
      <ApprovalCard approval={approval} onRespond={noop} />,
    );
    expect(html).toContain("を実行してもよいですか？");
    expect(html).toContain("Create a file");
    expect(html).toContain("touch a.txt");
    expect(html).toContain("許可");
    expect(html).toContain("拒否");
  });

  test("答えたあとは結果だけを出す", () => {
    expect(
      renderToString(
        <ApprovalCard
          approval={{ ...approval, status: "allowed" }}
          onRespond={noop}
        />,
      ),
    ).toContain("許可しました");
    const denied = renderToString(
      <ApprovalCard
        approval={{ ...approval, status: "denied", message: "危ない" }}
        onRespond={noop}
      />,
    );
    expect(denied).toContain("拒否しました");
    expect(denied).toContain("危ない");
  });
});

describe("notify", () => {
  test("承認待ちの件数をタイトルに出す", () => {
    expect(titleFor(0)).toBe("monet");
    expect(titleFor(2)).toBe("(2) 承認待ち - monet");
  });

  test("新たに承認待ちになった会話だけを返す", () => {
    const previous = new Map([
      ["a", "awaiting_approval"],
      ["b", "running"],
    ]);
    expect(
      newlyAwaiting(previous, [
        { id: "a", status: "awaiting_approval", title: "A" },
        { id: "b", status: "awaiting_approval", title: "B" },
        { id: "c", status: "idle", title: "C" },
      ]),
    ).toEqual([{ id: "b", status: "awaiting_approval", title: "B" }]);
  });
});
