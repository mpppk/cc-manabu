import { describe, expect, test } from "bun:test";
import {
  buildCitations,
  citationNumberFromHref,
  collectSources,
  linkCitations,
  normalizeUrl,
  type ToolCall,
} from "../../src/chat/citations.ts";

/** 実機の Claude Code の WebSearch の結果の形（docs/spikes/citations.md）。 */
const webSearch: ToolCall = {
  toolName: "WebSearch",
  input: { query: "bun" },
  output:
    'Web search results for query: "bun"\n\nLinks: [{"title":"Welcome to Bun","url":"https://bun.sh/docs"},{"title":"Bun (software)","url":"https://en.wikipedia.org/wiki/Bun_(software)"}]\n\nBun is a JavaScript runtime.',
};
const slack: ToolCall = {
  toolName: "mcp__slack__search_messages",
  input: { query: "deploy" },
  output: {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          messages: [
            {
              channel_name: "dev",
              text: "金曜にデプロイします",
              permalink:
                "https://example.slack.com/archives/C123/p1700000000000100",
            },
          ],
        }),
      },
    ],
  },
};
const cosense: ToolCall = {
  toolName: "mcp__cosense__get_page",
  input: { projectName: "team", pageTitle: "認可 設計" },
  output: "認可の設計メモ。",
};
const webFetch: ToolCall = {
  toolName: "WebFetch",
  input: { url: "https://example.com/spec", prompt: "要約" },
  output: "仕様のページ。",
};

describe("出典（#258）", () => {
  test("ツールの結果から、検索結果・Slack のパーマリンク・Cosense のページ・取得したページを集める", () => {
    const sources = collectSources([webSearch, slack, cosense, webFetch]);
    expect(sources.get("bun.sh/docs")).toMatchObject({
      kind: "web",
      title: "Welcome to Bun",
    });
    expect(
      sources.get("example.slack.com/archives/C123/p1700000000000100"),
    ).toMatchObject({
      kind: "slack",
      title: "dev",
      excerpt: "金曜にデプロイします",
    });
    expect(
      sources.get(normalizeUrl("https://cosen.se/team/認可_設計") ?? ""),
    ).toMatchObject({ kind: "cosense", title: "認可 設計" });
    expect(sources.get("example.com/spec")).toMatchObject({ kind: "web" });
  });

  test("URL の表記の違い（末尾の /・フラグメント・大文字・Cosense のホストとエンコード）をそろえる", () => {
    expect(normalizeUrl("https://Bun.sh/docs/#top")).toBe("bun.sh/docs");
    expect(
      normalizeUrl(
        "https://cosen.se/team/%E8%AA%8D%E5%8F%AF_%E8%A8%AD%E8%A8%88",
      ),
    ).toBe(normalizeUrl("https://scrapbox.io/team/認可 設計"));
    expect(normalizeUrl("javascript:alert(1)")).toBeUndefined();
  });

  test("本文の印に出てきた順で番号を付け、同じ出典は同じ番号、同じ箇所に複数付けられる", () => {
    const text = [
      "Bun はランタイムです。[出典](https://bun.sh/docs)",
      "- 金曜にデプロイ [出典](https://example.slack.com/archives/C123/p1700000000000100)[出典](https://cosen.se/team/認可_設計)",
      "- もう一度 [出典](https://bun.sh/docs/)",
      "- ノートによると [認可](wiki:w1)",
    ].join("\n");
    const citations = buildCitations({
      text,
      calls: [webSearch, slack, cosense],
      wikiTaskId: "t1",
      wikiPages: new Map([["w1", "認可"]]),
    });
    expect(citations.sources.map((s) => [s.n, s.kind])).toEqual([
      [1, "web"],
      [2, "slack"],
      [3, "cosense"],
      [4, "wiki"],
    ]);
    const linked = linkCitations(text, citations);
    expect(linked).toContain("ランタイムです。[1](#cite-1)");
    expect(linked).toContain("[2](#cite-2)[3](#cite-3)");
    expect(linked).toContain("もう一度 [1](#cite-1)");
    expect(linked).toContain("ノートによると [4](#cite-4)");
  });

  test("ツールの結果に無い URL・渡していないノートは出典にしない", () => {
    const text =
      "作った URL [出典](https://bun.sh)。別のノート [他](wiki:other)。結果の URL [出典](https://bun.sh/docs)";
    const citations = buildCitations({
      text,
      calls: [webSearch],
      wikiPages: new Map(),
    });
    expect(citations.sources.map((s) => s.url)).toEqual([
      "https://bun.sh/docs",
    ]);
    const linked = linkCitations(text, citations);
    // 出典にできない外部の印は通常のリンク、Wiki の印は文字だけ
    expect(linked).toContain("作った URL [出典](https://bun.sh)");
    expect(linked).toContain("別のノート 他。");
    expect(linked).toContain("結果の URL [1](#cite-1)");
  });

  test("画面内のリンクから番号を取り出す", () => {
    expect(citationNumberFromHref("#cite-3")).toBe(3);
    expect(citationNumberFromHref("#user-content-cite-12")).toBe(12);
    expect(citationNumberFromHref("#wiki-x")).toBeUndefined();
  });
});
