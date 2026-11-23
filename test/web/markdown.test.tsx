import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { Markdown } from "../../src/web/components/markdown.tsx";
import { Reasoning } from "../../src/web/components/reasoning.tsx";
import {
  summaryOf,
  WikiTermsContext,
} from "../../src/web/components/wiki-term.tsx";
import { createTermMatcher } from "../../src/wiki/term-matcher.ts";

describe("Markdown", () => {
  test("1 行ずつの改行を改行として表示する", () => {
    const html = renderToString(<Markdown text={"1\n2\n3"} />);
    expect(html.match(/<br\s*\/?>/g)).toHaveLength(2);
  });

  test("閉じていないコードブロックも描画する", () => {
    const html = renderToString(
      <Markdown text={"```ts\nconst a = 1;"} streaming />,
    );
    expect(html).toContain('data-streamdown="code-block"');
  });

  test("数式を KaTeX で描画する", () => {
    expect(renderToString(<Markdown text="$$E = mc^2$$" />)).toContain("katex");
  });

  test("Wiki の引用は画面内のリンクに、ほかのリンクは既定の表示にする", () => {
    const html = renderToString(
      <Markdown
        text="[関係タプル](#wiki-p1) と [外部](https://example.com)"
        wikiLinks={{ href: (id) => `/p/x/wiki/${id}`, onOpen: () => {} }}
      />,
    );
    expect(html).toContain('href="/p/x/wiki/p1"');
    expect(html).toContain('data-wiki-page="p1"');
    expect(html).toContain('data-streamdown="link"');
  });
});

describe("Markdown の用語（#81）", () => {
  const termMatcher = createTermMatcher([
    { pageId: "tuple", names: ["関係タプル", "relation tuple"] },
  ]);
  const render = (text: string) =>
    renderToString(
      <WikiTermsContext.Provider
        value={{ load: async () => undefined, open: () => {} }}
      >
        <Markdown text={text} termMatcher={termMatcher} />
      </WikiTermsContext.Provider>,
    );
  const terms = (html: string) =>
    html.match(/data-wiki-term="tuple"/g)?.length ?? 0;

  test("本文の用語名と英語の別名を、同じページの用語にする", () => {
    const html = render("**関係タプル**（Relation Tuple）を使う。");
    expect(terms(html)).toBe(2);
    expect(html).toContain('data-streamdown="strong"');
  });

  test("コード・インラインコード・数式・リンクの中は用語にしない", () => {
    const html = render(
      [
        "`関係タプル` と [関係タプル](https://example.com)",
        "",
        "```",
        "関係タプル",
        "```",
        "",
        "$$\\text{関係タプル}$$",
      ].join("\n"),
    );
    expect(terms(html)).toBe(0);
    expect(html).toContain('data-streamdown="code-block"');
    expect(html).toContain("katex");
    expect(html).toContain('data-streamdown="link"');
  });

  test("用語が無い本文はそのまま", () => {
    expect(terms(render("関係のない文"))).toBe(0);
  });
});

test("summaryOf は見出しや記号を除いた本文の先頭", () => {
  expect(summaryOf("# 見出し\n**3 つ組**の `データ`。\n## 例\n- a")).toBe(
    "3 つ組の データ。 - a",
  );
  expect(summaryOf("あ".repeat(200), 10)).toBe(`${"あ".repeat(10)}…`);
});

describe("Reasoning", () => {
  test("本文があれば折り畳みで表示する", () => {
    const html = renderToString(
      <Reasoning text="まず A を考える" streaming={false} />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("思考の過程");
    expect(html).toContain("まず A を考える");
  });

  test("本文が無くても、考えている間はそれを示す", () => {
    expect(renderToString(<Reasoning text="" streaming />)).toContain(
      "考えています",
    );
    expect(renderToString(<Reasoning text="" streaming={false} />)).toBe("");
  });
});
