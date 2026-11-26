/**
 * 実機の claude で、タスクのスレッドから Claude が Wiki を編集・作成できることを確かめる。CI では実行しない。
 *
 *   bun run test:live
 *
 * 前提: `claude` がインストールされてログイン済みであること。サブスクの利用枠を少し消費する。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createRouterClient } from "@orpc/server";
import type { QueryFunction } from "../../src/provider/index.ts";
import { router } from "../../src/router.ts";
import { WIKI_TOOL_NAMES } from "../../src/wiki/tool-names.ts";
import { createTestContext } from "../helpers/context.ts";

const LIVE = process.env.MONET_LIVE === "1";
const TIMEOUT = 180_000;

const REQUEST =
  "Wiki の「冪等性キー」のページの本文の末尾に「例: 決済 API の再送。」という 1 行を追記し、「再送」というタイトルの新しいページ（本文は 1 文）も作ってください。ほかの作業はせず、終わったら「完了」とだけ答えてください。";

describe.skipIf(!LIVE)("live: Wiki のツール", () => {
  let cwd = "";
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "cc-manabu-live-wiki-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const setup = async () => {
    const claudePath = Bun.which("claude") ?? undefined;
    // 利用者の設定（CLAUDE.md やフック）に左右されないようにする
    const live: QueryFunction = ({ prompt, options }) =>
      query({
        prompt,
        options: {
          ...options,
          cwd,
          settingSources: [],
          ...(claudePath === undefined
            ? {}
            : { pathToClaudeCodeExecutable: claudePath }),
        },
      });
    const ctx = createTestContext({ query: live });
    const client = createRouterClient(router, { context: ctx.context });
    const task = await client.tasks.create({ name: "live" });
    const page = await client.wiki.create({
      taskId: task.id,
      title: "冪等性キー",
      aliases: [],
      body: "同じ要求を何度送っても結果が変わらないようにするキー。",
    });
    /** 生成を読み切る。書き換えるツールは承認を求めるので、届いたら許可する。 */
    const approveAll = async (
      chatId: string,
      chunks: AsyncIterable<{ type: string; data?: unknown }>,
    ) => {
      const asked: string[] = [];
      for await (const chunk of chunks) {
        const data = chunk.data as
          | { status?: string; toolName: string; approvalId: string }
          | undefined;
        if (chunk.type === "data-approval" && data?.status === "pending") {
          asked.push(data.toolName);
          await client.approvals.respond({
            chatId,
            approvalId: data.approvalId,
            behavior: "allow",
          });
        }
      }
      return asked;
    };
    const expectEdited = async (asked: string[]) => {
      expect(asked).toContain(WIKI_TOOL_NAMES.createPage);
      expect(
        asked.some(
          (name) =>
            name === WIKI_TOOL_NAMES.editPage ||
            name === WIKI_TOOL_NAMES.updatePage,
        ),
      ).toBe(true);
      // 読むツールは承認を求めない
      expect(asked).not.toContain(WIKI_TOOL_NAMES.readPage);
      expect(asked).not.toContain(WIKI_TOOL_NAMES.listPages);
      expect((await client.wiki.get({ id: page.id })).body).toContain(
        "決済 API の再送",
      );
      const pages = await client.wiki.list({ taskId: task.id });
      expect(pages.map((p) => p.title)).toContain("再送");
    };
    return { client, task, page, approveAll, expectEdited };
  };

  const message = () => ({
    id: crypto.randomUUID(),
    role: "user" as const,
    parts: [{ type: "text", text: REQUEST }],
  });

  test(
    "Wiki ページの会話で頼むと、承認のうえでページを編集し、新しいページを作る",
    async () => {
      const { client, task, page, approveAll, expectEdited } = await setup();
      const { chatId } = await client.wiki.ask({
        taskId: task.id,
        pageId: page.id,
        model: "haiku",
        effort: null,
        message: message(),
      });
      await expectEdited(
        await approveAll(chatId, await client.chat.reconnect({ chatId })),
      );
    },
    TIMEOUT,
  );

  test(
    "タスクのふつうのスレッドで頼んでも、承認のうえでページを編集し、新しいページを作る",
    async () => {
      const { client, task, approveAll, expectEdited } = await setup();
      const chat = await client.chats.create({
        taskId: task.id,
        model: "haiku",
        effort: null,
      });
      await expectEdited(
        await approveAll(
          chat.id,
          await client.chat.send({ chatId: chat.id, message: message() }),
        ),
      );
    },
    TIMEOUT,
  );
});
