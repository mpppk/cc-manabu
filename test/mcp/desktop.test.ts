import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Result } from "@praha/byethrow";
import { createEnvironmentRepository } from "../../src/db/environment-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import { createTaskRepository } from "../../src/db/task-repository.ts";
import { createWikiHistoryRepository } from "../../src/db/wiki-history-repository.ts";
import { createWikiRepository } from "../../src/db/wiki-repository.ts";
import { createDesktopMcpServer } from "../../src/mcp/desktop-server.ts";

const unwrap = <T>(result: Result.Result<T, unknown>): T => {
  if (Result.isFailure(result)) throw result.error;
  return result.value;
};

const reposOf = (dbPath: string) => {
  const { db, sqlite } = unwrap(openDatabase(dbPath));
  return {
    sqlite,
    tasks: createTaskRepository(db),
    environments: createEnvironmentRepository(db),
    wiki: createWikiRepository(db),
    history: createWikiHistoryRepository(db),
  };
};

type CallResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};

const connect = async (repos: ReturnType<typeof reposOf>, home: string) => {
  const server = createDesktopMcpServer({ ...repos, defaultDirectory: home });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as CallResult;
    return {
      text: result.content.map((c) => c.text).join("\n"),
      isError: result.isError === true,
    };
  };
  return { client, call };
};

const temps: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "monet-mcp-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true });
});

const idOf = (text: string, key: string) =>
  new RegExp(`${key}: ([\\w-]+)`).exec(text)?.[1] ?? "";

describe("Claude Desktop 向けの MCP サーバ（#212）", () => {
  test("ツールの一覧に、読むツールは readOnlyHint を付けて出す", async () => {
    const { client } = await connect(reposOf(":memory:"), tempDir());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_link",
        "create_page",
        "create_task",
        "edit_page",
        "get_task",
        "list_environments",
        "list_pages",
        "list_tasks",
        "read_page",
        "update_link",
        "update_page",
        "update_task",
      ].sort(),
    );
    const readOnly = tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name)
      .sort();
    expect(readOnly).toEqual(
      [
        "get_task",
        "list_environments",
        "list_pages",
        "list_tasks",
        "read_page",
      ].sort(),
    );
    expect(client.getInstructions()).toContain("確認してから書き込む");
  });

  test("タスクを指定しないと、選び方の分かるエラーを返す", async () => {
    const { call } = await connect(reposOf(":memory:"), tempDir());
    for (const name of ["get_task", "list_pages", "update_task"]) {
      const result = await call(name, { name: "x" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("list_tasks");
    }
    const missing = await call("get_task", { task_id: "missing" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("タスクが見つかりません");
  });

  test("タスクを新しい環境・既存の環境に作り、探して、指定した項目だけを編集できる", async () => {
    const repos = reposOf(":memory:");
    const home = tempDir();
    const { call } = await connect(repos, home);

    // 新しい環境（タスクと同じ名前の環境と Wiki）
    const created = await call("create_task", { name: "個人情報管理" });
    expect(created.isError).toBe(false);
    expect(created.text).toContain("タスクを作成しました。");
    expect(created.text).toContain("環境: 個人情報管理");
    expect(created.text).toContain("Wiki: 個人情報管理");
    const taskId = idOf(created.text, "task_id");
    const environmentId = idOf(created.text, "environment_id");
    const environment = unwrap(
      repos.environments.getEnvironment(environmentId),
    );
    expect(environment.directories).toEqual([home]);

    // 既存の環境
    const shared = await call("create_task", {
      name: "委託先の管理",
      environment_id: environmentId,
    });
    expect(shared.text).toContain("環境: 個人情報管理");
    const sharedId = idOf(shared.text, "task_id");
    expect(unwrap(repos.tasks.getTask(sharedId)).environmentId).toBe(
      environmentId,
    );
    expect(
      (await call("create_task", { name: "x", environment_id: "missing" }))
        .text,
    ).toContain("list_environments");

    // 探す
    const found = await call("list_tasks", { query: "委託" });
    expect(found.text).toContain(`委託先の管理（task_id: ${sharedId}`);
    expect(found.text).not.toContain(`task_id: ${taskId}`);
    expect((await call("list_environments")).text).toContain(
      "個人情報管理（environment_id:",
    );

    // 指定した項目だけを変える
    const updated = await call("update_task", {
      task_id: taskId,
      progress_note: "棚卸しを始めた",
    });
    expect(updated.text).toContain("進捗メモ: （なし） → 棚卸しを始めた");
    const after = unwrap(repos.tasks.getTask(taskId));
    expect(after).toMatchObject({
      name: "個人情報管理",
      status: "not_started",
      progressNote: "棚卸しを始めた",
      nextAction: "",
    });
    await call("update_task", {
      task_id: taskId,
      status: "in_progress",
      goal: "台帳を作る",
    });
    expect(unwrap(repos.tasks.getTask(taskId))).toMatchObject({
      status: "in_progress",
      progressNote: "棚卸しを始めた",
      nextAction: "台帳を作る",
    });

    // 環境を移すと、移った先の Wiki を参照する
    const other = await call("create_task", { name: "別件" });
    const otherEnvironment = idOf(other.text, "environment_id");
    const moved = await call("update_task", {
      task_id: sharedId,
      environment_id: otherEnvironment,
    });
    expect(moved.text).toContain("参照する Wiki は「別件」になります。");
    expect((await call("get_task", { task_id: sharedId })).text).toContain(
      "Wiki: 別件",
    );
  });

  test("Wiki のノートを読み書きし、Claude Desktop からの変更として版に残す", async () => {
    const repos = reposOf(":memory:");
    const { call } = await connect(repos, tempDir());
    const taskId = idOf(
      (await call("create_task", { name: "用語集" })).text,
      "task_id",
    );
    const created = await call("create_page", {
      task_id: taskId,
      title: "第三者提供",
      body: "本人以外に渡すこと。",
    });
    expect(created.text).toContain("ページ「第三者提供」を作成しました");
    const pageId = idOf(created.text, "id");
    await call("edit_page", {
      task_id: taskId,
      id: pageId,
      old_string: "本人以外",
      new_string: "本人以外の第三者",
    });
    expect(
      (await call("read_page", { task_id: taskId, id: pageId })).text,
    ).toContain("本人以外の第三者に渡すこと。");
    expect((await call("list_pages", { task_id: taskId })).text).toContain(
      `第三者提供（id: ${pageId}）`,
    );
    const versions = unwrap(repos.history.listPageVersions(pageId));
    expect(versions.map((v) => v.actor)).toEqual([
      "claude_desktop",
      "claude_desktop",
    ]);

    // ほかのタスクの Wiki のノートは扱わない
    const other = idOf(
      (await call("create_task", { name: "別の Wiki" })).text,
      "task_id",
    );
    expect(
      (await call("read_page", { task_id: other, id: pageId })).isError,
    ).toBe(true);
  });

  test("関連リンクを追加・更新できる", async () => {
    const repos = reposOf(":memory:");
    const { call } = await connect(repos, tempDir());
    const taskId = idOf(
      (await call("create_task", { name: "リンク" })).text,
      "task_id",
    );
    const added = await call("add_link", {
      task_id: taskId,
      url: "https://example.com/a",
      label: "設計",
    });
    expect(added.text).toContain("関連リンクを追加しました。");
    const linkId = idOf(added.text, "id");
    await call("update_link", {
      task_id: taskId,
      id: linkId,
      url: "https://example.com/b",
    });
    expect(unwrap(repos.tasks.listLinks(taskId))).toMatchObject([
      { url: "https://example.com/b", label: "設計" },
    ]);
  });

  test("標準入力が閉じたら（Claude Desktop が終了したら）`monet mcp` も終了する", async () => {
    const dir = tempDir();
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "../../src/binary.ts"),
        "mcp",
      ],
      {
        env: { ...process.env, MONET_DB: path.join(dir, "db.sqlite") },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      })}\n`,
    );
    await child.stdin.end();
    const stdout = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    // 標準出力は MCP のメッセージだけ
    expect(
      stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).id),
    ).toEqual([1]);
  }, 20_000);

  test("`monet mcp` を stdio で起動し、起動中の monet と同じ DB を読み書きできる", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "db.sqlite");
    // monet が起動していて、同じ DB を開いている
    const running = reposOf(dbPath);
    const task = unwrap(
      running.tasks.createTask({ name: "起動中のタスク", directories: [dir] }),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(import.meta.dir, "../../src/binary.ts"), "mcp"],
      env: { ...process.env, MONET_DB: dbPath } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const listed = (await client.callTool({
        name: "list_tasks",
        arguments: {},
      })) as CallResult;
      expect(listed.content[0]?.text).toContain(
        `起動中のタスク（task_id: ${task.id}`,
      );
      const created = (await client.callTool({
        name: "create_page",
        arguments: { task_id: task.id, title: "共有", body: "本文" },
      })) as CallResult;
      expect(created.isError).toBeFalsy();
      // monet 側から、Claude Desktop が書いたノートが見える
      expect(
        unwrap(running.wiki.listPages(task.wikiId ?? task.id)).map(
          (p) => p.title,
        ),
      ).toEqual(["共有"]);
    } finally {
      await client.close();
      running.sqlite.close();
    }
  }, 20_000);
});
