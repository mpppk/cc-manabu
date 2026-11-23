import { describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import {
  type ApprovalChunk,
  createApprovalBroker,
  DEFAULT_DENY_MESSAGE,
} from "../../src/chat/approval-broker.ts";

const context = (signal = new AbortController().signal) => ({
  signal,
  suggestions: [],
  toolUseID: "toolu_1",
  displayName: "Bash",
  description: "Create a file",
});

const setup = () => {
  const changes: [string, number][] = [];
  const broker = createApprovalBroker({
    onPendingChange: (chatId, count) => changes.push([chatId, count]),
  });
  const chunks: ApprovalChunk[] = [];
  const canUseTool = broker.createCanUseTool("c1", (c) => chunks.push(c));
  return { broker, chunks, changes, canUseTool };
};

describe("ApprovalBroker", () => {
  test("読み取り系のツールは承認なしで許可する", async () => {
    const { canUseTool, chunks } = setup();
    expect(
      await canUseTool("Read", { file_path: "/a" }, context() as never),
    ).toEqual({ behavior: "allow", updatedInput: { file_path: "/a" } });
    expect(chunks).toEqual([]);
  });

  test("WebFetch は自動で許可しない", async () => {
    const { canUseTool, broker } = setup();
    void canUseTool("WebFetch", { url: "https://x" }, context() as never);
    expect(broker.pendingFor("c1")).toHaveLength(1);
  });

  test("承認要求を流し、許可すると allow で解決して allowed を流す", async () => {
    const { canUseTool, chunks, broker, changes } = setup();
    const decision = canUseTool(
      "Bash",
      { command: "touch a" },
      context() as never,
    );
    expect(chunks).toHaveLength(1);
    const pending = chunks[0];
    expect(pending?.data).toMatchObject({
      toolName: "Bash",
      toolUseId: "toolu_1",
      description: "Create a file",
      input: { command: "touch a" },
      status: "pending",
    });
    const approvalId = pending?.data.approvalId ?? "";
    expect(
      Result.isSuccess(
        broker.respond({ chatId: "c1", approvalId, behavior: "allow" }),
      ),
    ).toBe(true);
    expect(await decision).toEqual({
      behavior: "allow",
      updatedInput: { command: "touch a" },
    });
    expect(chunks[1]).toMatchObject({
      id: approvalId,
      data: { status: "allowed" },
    });
    expect(changes).toEqual([
      ["c1", 1],
      ["c1", 0],
    ]);
  });

  test("拒否すると理由付きの deny で解決する（理由が空なら既定の文言）", async () => {
    const { canUseTool, chunks, broker } = setup();
    const first = canUseTool("Bash", {}, context() as never);
    broker.respond({
      chatId: "c1",
      approvalId: chunks[0]?.data.approvalId ?? "",
      behavior: "deny",
      message: "危ないのでやめて",
    });
    expect(await first).toEqual({
      behavior: "deny",
      message: "危ないのでやめて",
    });
    const second = canUseTool("Bash", {}, context() as never);
    broker.respond({
      chatId: "c1",
      approvalId: chunks[2]?.data.approvalId ?? "",
      behavior: "deny",
      message: " ",
    });
    expect(await second).toEqual({
      behavior: "deny",
      message: DEFAULT_DENY_MESSAGE,
    });
  });

  test("別の会話や存在しない ID には答えられない", () => {
    const { canUseTool, chunks, broker } = setup();
    void canUseTool("Bash", {}, context() as never);
    const approvalId = chunks[0]?.data.approvalId ?? "";
    for (const result of [
      broker.respond({ chatId: "other", approvalId, behavior: "allow" }),
      broker.respond({ chatId: "c1", approvalId: "nope", behavior: "allow" }),
    ]) {
      expect(Result.isFailure(result) && result.error.name).toBe(
        "ApprovalNotFoundError",
      );
    }
    expect(broker.pendingFor("c1")).toHaveLength(1);
  });

  test("中断されたら deny で解決する（signal・denyAll）", async () => {
    const { canUseTool, chunks, broker } = setup();
    const controller = new AbortController();
    const bySignal = canUseTool(
      "Bash",
      {},
      context(controller.signal) as never,
    );
    const byDenyAll = canUseTool("Bash", {}, context() as never);
    controller.abort();
    expect((await bySignal)?.behavior).toBe("deny");
    broker.denyAll("c1");
    expect((await byDenyAll)?.behavior).toBe("deny");
    expect(chunks.filter((c) => c.data.status === "denied")).toHaveLength(2);
    expect(broker.pendingFor("c1")).toEqual([]);
  });
});
