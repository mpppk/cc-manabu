import { beforeEach, describe, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import { openDatabase } from "../../src/db/index.ts";
import {
  createTaskRepository,
  requireWikiId,
} from "../../src/db/task-repository.ts";
import {
  createWikiHistoryRepository,
  NothingToUndoError,
  WikiHistoryConflictError,
  type WikiHistoryRepository,
} from "../../src/db/wiki-history-repository.ts";
import {
  createWikiRepository,
  type WikiRepository,
} from "../../src/db/wiki-repository.ts";

const unwrap = <T>(result: Result.Result<T, unknown>): T => {
  if (Result.isFailure(result)) throw result.error;
  return result.value;
};

/** 環境の Wiki（テストのタスクは Wiki のある環境に作る）。 */
const wikiIdOf = (task: Parameters<typeof requireWikiId>[0]): string =>
  unwrap(requireWikiId(task));

let wiki: WikiRepository;
let history: WikiHistoryRepository;
let wikiId: string;

beforeEach(() => {
  const { db } = unwrap(openDatabase(":memory:"));
  wiki = createWikiRepository(db);
  history = createWikiHistoryRepository(db);
  wikiId = wikiIdOf(unwrap(createTaskRepository(db).createTask({ name: "t" })));
});

const create = (title: string, body = `${title} の本文`) =>
  unwrap(wiki.createPage({ wikiId, title, aliases: [], body }));
const bodyOf = (pageId: string) => {
  const page = wiki.getPage(pageId);
  return Result.isSuccess(page) ? page.value.body : undefined;
};

describe("版の記録", () => {
  test("作成・更新・削除のたびに、出どころ付きの版が残る", () => {
    const page = create("冪等性キー", "v1");
    unwrap(
      wiki.updatePage(
        page.id,
        { title: "冪等性キー", aliases: [], body: "v2" },
        { actor: "claude", chatId: "c1", tool: "edit_page", batchId: "run-1" },
      ),
    );
    unwrap(wiki.deletePage(page.id));
    const versions = unwrap(history.listPageVersions(page.id));
    expect(
      versions.map((v) => [v.actor, v.body, v.deleted, v.tool, v.chatId]),
    ).toEqual([
      ["user", "v2", true, null, null],
      ["claude", "v2", false, "edit_page", "c1"],
      ["user", "v1", false, null, null],
    ]);
    expect(
      unwrap(history.listDeletedPages(wikiId)).map((v) => v.title),
    ).toEqual(["冪等性キー"]);
  });

  test("用語ノートの自動作成も版に残る", () => {
    unwrap(
      wiki.createTermPages(
        wikiId,
        [{ term: "関係タプル", aliases: [], summary: "3 つ組" }],
        null,
      ),
    );
    const [page] = unwrap(wiki.listPages(wikiId));
    const [version] = unwrap(history.listPageVersions(page?.id ?? ""));
    expect(version?.actor).toBe("auto");
  });
});

describe("復元", () => {
  test("任意の版に復元でき、削除したページも戻る。復元も新しい版になる", () => {
    const page = create("委託", "v1");
    unwrap(
      wiki.updatePage(page.id, { title: "委託", aliases: [], body: "v2" }),
    );
    const [, first] = unwrap(history.listPageVersions(page.id));
    unwrap(history.restoreVersion(first?.seq ?? 0));
    expect(bodyOf(page.id)).toBe("v1");

    unwrap(wiki.deletePage(page.id));
    const [deleted] = unwrap(history.listPageVersions(page.id));
    unwrap(history.restoreVersion(deleted?.seq ?? 0));
    expect(bodyOf(page.id)).toBe("v1");
    expect(unwrap(history.listPageVersions(page.id)).map((v) => v.op)).toEqual([
      "restore",
      "change",
      "restore",
      "change",
      "change",
    ]);
  });
});

describe("元に戻す / やり直す", () => {
  test("直前の変更を戻し、やり直せる。新しい変更が入るとやり直せない", () => {
    const page = create("A", "v1");
    unwrap(wiki.updatePage(page.id, { title: "A", aliases: [], body: "v2" }));
    expect(unwrap(history.undoState(wikiId)).undo?.pages[0]?.title).toBe("A");

    unwrap(history.undo(wikiId));
    expect(bodyOf(page.id)).toBe("v1");
    unwrap(history.undo(wikiId));
    expect(bodyOf(page.id)).toBeUndefined();
    const nothing = history.undo(wikiId);
    expect(Result.isFailure(nothing) && nothing.error).toBeInstanceOf(
      NothingToUndoError,
    );

    unwrap(history.undo(wikiId, true));
    expect(bodyOf(page.id)).toBe("v1");
    unwrap(history.undo(wikiId, true));
    expect(bodyOf(page.id)).toBe("v2");

    unwrap(history.undo(wikiId));
    expect(unwrap(history.undoState(wikiId)).redo).toBeDefined();
    create("B");
    expect(unwrap(history.undoState(wikiId)).redo).toBeUndefined();
  });

  test("後から別の変更が入ったページは、上書きせずに知らせる", () => {
    const page = create("A", "v1");
    unwrap(
      wiki.updatePage(
        page.id,
        { title: "A", aliases: [], body: "claude" },
        { actor: "claude", batchId: "run-1", chatId: "c1" },
      ),
    );
    unwrap(history.attachAnswer("run-1", "answer-1"));
    unwrap(wiki.updatePage(page.id, { title: "A", aliases: [], body: "user" }));

    const result = history.undoAnswer("answer-1");
    expect(Result.isFailure(result) && result.error).toBeInstanceOf(
      WikiHistoryConflictError,
    );
    expect(bodyOf(page.id)).toBe("user");
  });

  test("回答で Claude が変えた複数のページを、まとめて戻してやり直せる", () => {
    const a = create("A", "a1");
    const b = create("B", "b1");
    const change = { actor: "claude" as const, batchId: "run-2", chatId: "c1" };
    unwrap(
      wiki.updatePage(a.id, { title: "A", aliases: [], body: "a2" }, change),
    );
    unwrap(
      wiki.updatePage(b.id, { title: "B", aliases: [], body: "b2" }, change),
    );
    const c = unwrap(
      wiki.createPage({ wikiId, title: "C", aliases: [], body: "c" }, change),
    );
    unwrap(history.attachAnswer("run-2", "answer-2"));
    // あとから関係ないページを変えても、回答の変更は戻せる
    create("D");

    expect(unwrap(history.answerChanges("answer-2"))?.batch.pages).toHaveLength(
      3,
    );
    unwrap(history.undoAnswer("answer-2"));
    expect([bodyOf(a.id), bodyOf(b.id), bodyOf(c.id)]).toEqual([
      "a1",
      "b1",
      undefined,
    ]);
    expect(unwrap(history.answerChanges("answer-2"))?.undone).toBe(true);
    unwrap(history.undoAnswer("answer-2", true));
    expect([bodyOf(a.id), bodyOf(b.id), bodyOf(c.id)]).toEqual([
      "a2",
      "b2",
      "c",
    ]);
  });
});

describe("チェックポイント", () => {
  test("Wiki 全体をその時点に戻し（追加・削除を含む）、戻したことも元に戻せる", () => {
    const a = create("A", "a1");
    const b = create("B", "b1");
    const checkpoint = unwrap(
      history.createCheckpoint({ wikiId, name: "整理する前" }),
    );
    unwrap(wiki.updatePage(a.id, { title: "A", aliases: [], body: "a2" }));
    unwrap(wiki.deletePage(b.id));
    const c = create("C");

    expect(unwrap(history.restoreCheckpoint(checkpoint.id))).toBe(3);
    expect([bodyOf(a.id), bodyOf(b.id), bodyOf(c.id)]).toEqual([
      "a1",
      "b1",
      undefined,
    ]);
    expect(
      unwrap(history.listCheckpoints(wikiId)).map((cp) => cp.name),
    ).toEqual(["整理する前"]);

    unwrap(history.undo(wikiId));
    expect([bodyOf(a.id), bodyOf(b.id), bodyOf(c.id)]).toEqual([
      "a2",
      undefined,
      "C の本文",
    ]);
  });
});
