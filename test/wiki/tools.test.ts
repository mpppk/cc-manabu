import { describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import { createApprovalBroker } from "../../src/chat/approval-broker.ts";
import { WIKI_TOOL_NAMES, wikiToolLabel } from "../../src/wiki/tool-names.ts";
import {
  createWikiToolHandlers,
  createWikiToolServers,
  WikiToolInputError,
  wikiToolInstructions,
} from "../../src/wiki/tools.ts";
import { createTestContext } from "../helpers/context.ts";

const setup = () => {
  const ctx = createTestContext();
  const task = Result.unwrap(ctx.tasks.createTask({ name: "決済" }));
  const other = Result.unwrap(ctx.tasks.createTask({ name: "別の Wiki" }));
  const wikiId = task.wikiId ?? task.id;
  const page = Result.unwrap(
    ctx.wiki.createPage({
      wikiId,
      title: "冪等性キー",
      aliases: ["idempotency key"],
      body: "同じ要求を何度送っても結果が変わらないようにするキー。\n\n## 使いどころ\n\n決済 API の再送。",
    }),
  );
  const handlers = createWikiToolHandlers(
    { wiki: ctx.wiki, tasks: ctx.tasks },
    { taskId: task.id },
  );
  return { ...ctx, task, other, page, handlers, wikiId };
};

const errorOf = (result: Result.Result<string, unknown>) => {
  expect(Result.isFailure(result)).toBe(true);
  return Result.isFailure(result) ? result.error : undefined;
};

describe("Wiki のツール（Claude が Wiki を読み書きする）", () => {
  test("一覧と読み込み", () => {
    const { handlers, page } = setup();
    const list = Result.unwrap(handlers.listPages());
    expect(list).toContain(
      `冪等性キー（id: ${page.id}、別名: idempotency key）`,
    );
    const read = Result.unwrap(handlers.readPage({ id: page.id }));
    expect(read).toContain(`id: ${page.id}`);
    expect(read).toContain("タイトル: 冪等性キー");
    expect(read).toContain("## 使いどころ");
  });

  test("ほかの Wiki のページは id を指定しても読めない・書けない", () => {
    const { handlers, wiki, other } = setup();
    const foreign = Result.unwrap(
      wiki.createPage({
        wikiId: other.wikiId ?? other.id,
        title: "よその手順",
        aliases: [],
        body: "秘密",
      }),
    );
    expect(errorOf(handlers.readPage({ id: foreign.id }))).toBeInstanceOf(
      WikiToolInputError,
    );
    expect(
      errorOf(handlers.updatePage({ id: foreign.id, body: "上書き" })),
    ).toBeInstanceOf(WikiToolInputError);
    expect(Result.unwrap(wiki.getPage(foreign.id)).body).toBe("秘密");
    expect(errorOf(handlers.readPage({ id: "missing" }))).toBeInstanceOf(
      WikiToolInputError,
    );
  });

  test("ページを作る。同じ名前（タイトルか別名）があれば作らない", () => {
    const { handlers, wiki, wikiId } = setup();
    const created = Result.unwrap(
      handlers.createPage({
        title: " 再送 ",
        aliases: ["retry", " ", "retry"],
        body: "失敗した要求をもう一度送ること。",
      }),
    );
    expect(created).toContain("ページ「再送」を作成しました");
    const pages = Result.unwrap(wiki.listPages(wikiId));
    expect(pages.find((p) => p.title === "再送")).toMatchObject({
      aliases: ["retry"],
      origin: "manual",
    });

    const duplicate = errorOf(
      handlers.createPage({ title: "Idempotency Key", body: "重複" }),
    );
    expect(duplicate).toBeInstanceOf(WikiToolInputError);
    expect((duplicate as Error).message).toContain("冪等性キー");
    expect(Result.unwrap(wiki.listPages(wikiId))).toHaveLength(2);
  });

  test("タイトル・別名・本文を書き換える。指定しない項目はそのまま", () => {
    const { handlers, wiki, page } = setup();
    expect(Result.isFailure(handlers.updatePage({ id: page.id }))).toBe(true);
    Result.unwrap(handlers.updatePage({ id: page.id, aliases: ["冪等キー"] }));
    const updated = Result.unwrap(wiki.getPage(page.id));
    expect(updated).toMatchObject({
      title: "冪等性キー",
      aliases: ["冪等キー"],
      body: page.body,
    });

    Result.unwrap(
      handlers.createPage({ title: "再送", aliases: [], body: "再送の説明" }),
    );
    // ほかのページと名前が重なる書き換えはしない
    expect(
      errorOf(handlers.updatePage({ id: page.id, title: "再送" })),
    ).toBeInstanceOf(WikiToolInputError);
    expect(Result.unwrap(wiki.getPage(page.id)).title).toBe("冪等性キー");
  });

  test("本文の一部を置き換える。見つからない・複数あるときは書き換えない", () => {
    const { handlers, wiki, page } = setup();
    Result.unwrap(
      handlers.editPage({
        id: page.id,
        old_string: "決済 API の再送。",
        new_string: "決済 API の再送。再送は切断後にも使う。",
      }),
    );
    expect(Result.unwrap(wiki.getPage(page.id)).body).toEndWith(
      "決済 API の再送。再送は切断後にも使う。",
    );

    const missing = errorOf(
      handlers.editPage({ id: page.id, old_string: "無い文", new_string: "x" }),
    );
    expect((missing as Error).message).toContain("見つかりません");
    const multiple = errorOf(
      handlers.editPage({ id: page.id, old_string: "再送", new_string: "x" }),
    );
    expect((multiple as Error).message).toContain("2 箇所");

    Result.unwrap(
      handlers.editPage({
        id: page.id,
        old_string: "再送",
        new_string: "リトライ",
        replace_all: true,
      }),
    );
    const body = Result.unwrap(wiki.getPage(page.id)).body;
    expect(body).not.toContain("再送");
    expect(body.split("リトライ")).toHaveLength(3);
  });

  test("置き換えの文字列に $ が入っていても、そのまま書く", () => {
    const { handlers, wiki, page } = setup();
    Result.unwrap(
      handlers.editPage({
        id: page.id,
        old_string: "決済 API の再送。",
        new_string: "料金は $& と $1 で表す。",
      }),
    );
    expect(Result.unwrap(wiki.getPage(page.id)).body).toEndWith(
      "料金は $& と $1 で表す。",
    );
  });

  test("会話ごとの MCP サーバは wiki という名前で、ページにひも付かない会話や削除済みのページでも作る", () => {
    const { wiki, tasks, task, page } = setup();
    const servers = createWikiToolServers({ wiki, tasks });
    for (const pageId of [page.id, null, "missing"]) {
      const created = servers({ taskId: task.id, pageId });
      expect(Object.keys(created)).toEqual(["wiki"]);
      expect(created.wiki).toMatchObject({ type: "sdk", name: "wiki" });
    }
  });

  test("Wiki ページの会話ではそのページを、ほかの会話では Wiki の使い方だけを伝える", () => {
    const forPage = wikiToolInstructions({ id: "page-1", title: "冪等性キー" });
    expect(forPage).toContain("Wiki ページ「冪等性キー」（id: page-1）");
    const general = wikiToolInstructions(undefined);
    expect(general).not.toContain("この会話は Wiki ページ");
    expect(general).toContain("利用者が求めていない編集や削除はしない");
  });

  test("読むツールは承認なしで使え、書くツールは承認を求める", async () => {
    const broker = createApprovalBroker();
    const emitted: unknown[] = [];
    const canUseTool = broker.createCanUseTool("chat-1", (chunk) =>
      emitted.push(chunk),
    );
    const context = {
      signal: new AbortController().signal,
      toolUseID: "tool-1",
      suggestions: [],
    } as unknown as Parameters<typeof canUseTool>[2];
    expect(
      await canUseTool(WIKI_TOOL_NAMES.readPage, { id: "p" }, context),
    ).toMatchObject({ behavior: "allow" });
    expect(
      await canUseTool(WIKI_TOOL_NAMES.listPages, {}, context),
    ).toMatchObject({ behavior: "allow" });
    expect(emitted).toHaveLength(0);

    const pending = canUseTool(
      WIKI_TOOL_NAMES.editPage,
      { id: "p", old_string: "a", new_string: "b" },
      context,
    );
    expect(broker.pendingFor("chat-1")).toHaveLength(1);
    broker.denyAll("chat-1");
    expect(await pending).toMatchObject({ behavior: "deny" });
  });

  test("画面に出す名前", () => {
    expect(wikiToolLabel(WIKI_TOOL_NAMES.editPage)).toBe("Wiki: ノートを編集");
    expect(wikiToolLabel("Bash")).toBeUndefined();
  });
});
