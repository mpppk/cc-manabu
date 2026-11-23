import { describe, expect, test } from "bun:test";
import type { DynamicToolUIPart } from "ai";
import { renderToString } from "react-dom/server";
import { ToolCard } from "../../src/web/components/tool-card.tsx";
import {
  outputToText,
  simpleDiff,
  summarizeToolInput,
  truncate,
} from "../../src/web/lib/tool-display.ts";

describe("summarizeToolInput", () => {
  test.each([
    ["Bash", { command: "ls -la", description: "List" }, "ls -la"],
    ["Read", { file_path: "/a/b.ts" }, "/a/b.ts"],
    ["Edit", { file_path: "/a/b.ts", old_string: "x" }, "/a/b.ts"],
    ["Grep", { pattern: "TODO" }, "TODO"],
    ["WebFetch", { url: "https://example.com" }, "https://example.com"],
    ["WebSearch", { query: "bun" }, "bun"],
    ["Unknown", { description: "何か" }, "何か"],
    ["Bash", null, ""],
  ] as const)("%s", (toolName, input, expected) => {
    expect(summarizeToolInput(toolName, input)).toBe(expected);
  });
});

describe("simpleDiff", () => {
  test("共通の前後は context、間を removed / added にする", () => {
    expect(simpleDiff("a\nb\nc", "a\nB\nB2\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "added", text: "B2" },
      { kind: "context", text: "c" },
    ]);
  });

  test("同じなら context だけ", () => {
    expect(simpleDiff("a", "a")).toEqual([{ kind: "context", text: "a" }]);
  });
});

describe("truncate / outputToText", () => {
  test("長い出力は省略する", () => {
    expect(truncate("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(truncate("ab", 3)).toEqual({ text: "ab", truncated: false });
  });
  test("文字列以外は JSON にする", () => {
    expect(outputToText("x")).toBe("x");
    expect(outputToText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe("ToolCard", () => {
  const base = {
    type: "dynamic-tool",
    toolName: "Bash",
    toolCallId: "t1",
    input: { command: "touch a.txt" },
  } as const;

  test("完了したツールは入力と出力を表示する", () => {
    const html = renderToString(
      <ToolCard
        part={
          {
            ...base,
            state: "output-available",
            output: "done",
          } as DynamicToolUIPart
        }
      />,
    );
    expect(html).toContain("touch a.txt");
    expect(html).toContain("done");
    expect(html).toContain('aria-label="完了"');
  });

  test("拒否されたツールは拒否として表示する", () => {
    const html = renderToString(
      <ToolCard
        part={
          {
            ...base,
            state: "output-error",
            errorText: "ユーザーが拒否しました。",
          } as DynamicToolUIPart
        }
      />,
    );
    expect(html).toContain('aria-label="拒否"');
  });

  test("Edit は差分で表示する", () => {
    const html = renderToString(
      <ToolCard
        part={
          {
            type: "dynamic-tool",
            toolName: "Edit",
            toolCallId: "t2",
            state: "input-available",
            input: {
              file_path: "/a.ts",
              old_string: "const a = 1;",
              new_string: "const a = 2;",
            },
          } as DynamicToolUIPart
        }
      />,
    );
    expect(html).toContain("- <!-- -->const a = 1;");
    expect(html).toContain("+ <!-- -->const a = 2;");
    expect(html).toContain('aria-label="実行中"');
  });
});
