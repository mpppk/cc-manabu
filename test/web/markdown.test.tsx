import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { Markdown } from "../../src/web/components/markdown.tsx";
import { Reasoning } from "../../src/web/components/reasoning.tsx";
import {
  summaryOf,
  WikiTermsContext,
} from "../../src/web/components/wiki-term.tsx";
import { linkServiceOf } from "../../src/web/lib/link-service.ts";
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

  test("回答内の Cosense リンクは元の記法で表示し、ページ名を URL エンコードする", () => {
    const title = "日本語 ページ#1?率%/続き";
    const html = renderToString(
      <Markdown
        text={`[/Nota/xxx] と [/other-project/${title}]`}
        cosenseLinks
      />,
    );
    expect(html).toContain('href="https://cosen.se/Nota/xxx"');
    expect(html).toContain(">[/Nota/xxx]</a>");
    expect(html).toContain(
      `href="https://cosen.se/other-project/${encodeURIComponent(title)}"`,
    );
    expect(html).toContain(`>[/other-project/${title}]</a>`);
  });

  test("未完成の Cosense リンクとコード・数式・既存リンクを変換しない", () => {
    const html = renderToString(
      <Markdown
        text={[
          "[/Nota/別の記法](https://example.com) と `[/Nota/コード]`",
          "",
          "```",
          "[/Nota/ブロック]",
          "```",
          "",
          "$$\\text{[/Nota/数式]}$$",
          "",
          "[/Nota] と [/Nota/] と [/Nota/書きかけ",
        ].join("\n")}
        streaming
        cosenseLinks
      />,
    );
    expect(html).not.toContain('href="https://cosen.se/');
    expect(html).toContain('data-streamdown="link"');
    expect(html).toContain("[/Nota/書きかけ</p>");
    expect(html).toContain("katex");
    const complete = renderToString(
      <Markdown text="[/Nota/書きかけ]" streaming cosenseLinks />,
    );
    expect(complete).toContain(
      `href="https://cosen.se/Nota/${encodeURIComponent("書きかけ")}"`,
    );
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
        <Markdown text={text} termMatcher={termMatcher} cosenseLinks />
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

  test("Cosense リンクの中に Wiki の用語リンクを重ねない", () => {
    const html = render("[/Nota/関係タプル] と 関係タプル");
    expect(terms(html)).toBe(1);
    expect(html).toContain(">[/Nota/関係タプル]</a>");
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
    expect(html).toContain("思考");
    expect(html).toContain("まず A を考える");
  });

  test("本文が無くても、考えている間はそれを示す", () => {
    expect(renderToString(<Reasoning text="" streaming />)).toContain(
      "考えています",
    );
    expect(renderToString(<Reasoning text="" streaming={false} />)).toBe("");
  });
});

describe("リンク先のサービスのアイコン（#275）", () => {
  test("Cosense・Slack の URL を判定し、ほかのサイトや解釈できない URL は対象外", () => {
    expect(linkServiceOf("https://scrapbox.io/proj/ページ")).toBe("cosense");
    expect(linkServiceOf("https://cosen.se/proj/page")).toBe("cosense");
    // プロジェクトのトップなど、ページでなければ付けない
    expect(linkServiceOf("https://scrapbox.io/proj")).toBeUndefined();
    expect(
      linkServiceOf("https://acme.slack.com/archives/C1/p1700000000000100"),
    ).toBe("slack");
    expect(linkServiceOf("https://slack.com/intl/ja-jp")).toBe("slack");
    expect(linkServiceOf("https://example.com/slack.com")).toBeUndefined();
    expect(linkServiceOf("https://notslack.com/x")).toBeUndefined();
    expect(linkServiceOf("#wiki-p1")).toBeUndefined();
    expect(linkServiceOf(undefined)).toBeUndefined();
  });

  test("Markdown リンク・自動リンク・プロジェクト間リンクの先頭にアイコンを付け、ほかのリンク・コード・出典には付けない", () => {
    const html = renderToString(
      <Markdown
        text={[
          "[設計メモ](https://scrapbox.io/proj/設計メモ) と https://acme.slack.com/archives/C1/p1700000000000100",
          "[/Nota/xxx] と [外部](https://example.com)",
          "`https://scrapbox.io/proj/コード`",
          "根拠[出典](#cite-1)",
        ].join("\n\n")}
        cosenseLinks
        citations={[
          {
            n: 1,
            kind: "cosense",
            url: "https://scrapbox.io/proj/p",
            title: "p",
          },
        ]}
      />,
    );
    expect(html.match(/data-link-service="cosense"/g)).toHaveLength(2);
    expect(html.match(/data-link-service="slack"/g)).toHaveLength(1);
    // アイコンは読み上げず、リンクのラベルと同じリンクの中に置く
    expect(html).toMatch(
      /<a[^>]*>(?:(?!<\/a>).)*data-link-service="cosense"[^>]*aria-hidden="true"|<a[^>]*>(?:(?!<\/a>).)*aria-hidden="true"[^>]*data-link-service="cosense"/,
    );
  });
});
