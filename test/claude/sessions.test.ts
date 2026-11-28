import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "@praha/byethrow";
import {
  countUnimportedPrompts,
  createDesktopLauncher,
  isPrompt,
  type SavedMessage,
  type TranscriptEntry,
} from "../../src/claude/sessions.ts";

const prompt = (uuid: string, text = "質問"): TranscriptEntry => ({
  type: "user",
  uuid,
  message: { role: "user", content: text },
});
const reply = (uuid: string): TranscriptEntry => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", content: [{ type: "text", text: "回答" }] },
});
const toolResult = (uuid: string): TranscriptEntry => ({
  type: "user",
  uuid,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }],
  },
});
const q: SavedMessage = { role: "user", sdkUuid: null };
const a = (sdkUuid: string | null): SavedMessage => ({
  role: "assistant",
  sdkUuid,
});

describe("isPrompt（#244）", () => {
  test("利用者の質問だけを数える", () => {
    expect(isPrompt(prompt("1"))).toBe(true);
    // Monet の質問は引用や参照情報のタグで始まることがある
    expect(isPrompt(prompt("1", "<quote>引用</quote>\n質問"))).toBe(true);
    expect(
      isPrompt({
        type: "user",
        uuid: "1",
        message: { content: [{ type: "image", source: {} }] },
      }),
    ).toBe(true);
    expect(isPrompt(toolResult("1"))).toBe(false);
    expect(isPrompt(reply("1"))).toBe(false);
    expect(isPrompt({ ...prompt("1"), is_meta: true })).toBe(false);
    expect(isPrompt(prompt("1", "[Request interrupted by user]"))).toBe(false);
    expect(isPrompt(prompt("1", "<command-name>/goal</command-name>"))).toBe(
      false,
    );
    expect(isPrompt(prompt("1", "  "))).toBe(false);
  });
});

describe("countUnimportedPrompts（#244）", () => {
  const saved = [q, a("a1"), q, a("a2")];
  const own = [
    prompt("q1"),
    reply("x"),
    toolResult("t"),
    reply("a1"),
    prompt("q2"),
    reply("a2"),
  ];

  test("Monet の送信だけなら 0", () => {
    expect(countUnimportedPrompts(saved, own)).toBe(0);
  });

  test("最後の回答のあとに外で足した質問を数える", () => {
    expect(
      countUnimportedPrompts(saved, [
        ...own,
        prompt("d1"),
        reply("d1a"),
        prompt("d2"),
        reply("d2a"),
      ]),
    ).toBe(2);
  });

  test("外で足したあとに Monet で続けても、間に足した質問を数える", () => {
    expect(
      countUnimportedPrompts(
        [...saved, q, a("a3")],
        [...own, prompt("d1"), reply("d1a"), prompt("q3"), reply("a3")],
      ),
    ).toBe(1);
  });

  test("中断して回答の位置が残らなかった Monet の質問は、外の質問に数えない", () => {
    expect(
      countUnimportedPrompts(
        [...saved, q, a(null)],
        [...own, prompt("q3"), reply("partial")],
      ),
    ).toBe(0);
  });

  test("分岐元から写した回答がセッションに無くても、見つかった回答から照合する", () => {
    expect(
      countUnimportedPrompts(
        [q, a("parent"), q, a("a1")],
        [prompt("p"), reply("copied"), prompt("q1"), reply("a1"), prompt("d")],
      ),
    ).toBe(1);
  });

  test("Monet の回答が 1 つも見つからなければ照合できない", () => {
    expect(countUnimportedPrompts(saved, [prompt("x")])).toBeUndefined();
    expect(countUnimportedPrompts([q], [prompt("x")])).toBeUndefined();
  });
});

describe("createDesktopLauncher（#244）", () => {
  /** claude の代わりに動かすスクリプト。 */
  const script = (body: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "monet-desktop-")));
    const path = join(dir, "claude");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return { dir, path };
  };

  test("作業ディレクトリで claude --desktop --resume <id> を実行する", async () => {
    const { dir, path } = script(
      `pwd > "${"$"}0.cwd"; echo "$@" > "${"$"}0.args"`,
    );
    const result = await createDesktopLauncher(path)({
      sessionId: "s-1",
      cwd: dir,
    });
    expect(Result.isSuccess(result)).toBe(true);
    expect(readFileSync(`${path}.args`, "utf8").trim()).toBe(
      "--desktop --resume s-1",
    );
    expect(readFileSync(`${path}.cwd`, "utf8").trim()).toBe(dir);
  });

  test("失敗したら出力から理由を返す", async () => {
    const { dir, path } = script(
      `echo "error: unknown option '--desktop'" >&2; exit 1`,
    );
    const result = await createDesktopLauncher(path)({
      sessionId: "s-1",
      cwd: dir,
    });
    expect(Result.isFailure(result) && result.error.message).toContain(
      "unknown option '--desktop'",
    );
  });

  test("claude が無い・作業ディレクトリが無いときは起動しない", async () => {
    const missing = await createDesktopLauncher(undefined)({
      sessionId: "s",
      cwd: "/",
    });
    expect(Result.isFailure(missing) && missing.error.message).toContain(
      "見つかりません",
    );
    const { path } = script("exit 0");
    const noDir = await createDesktopLauncher(path)({
      sessionId: "s",
      cwd: "/no/such/dir",
    });
    expect(Result.isFailure(noDir) && noDir.error.message).toContain(
      "作業ディレクトリが見つかりません",
    );
  });
});
