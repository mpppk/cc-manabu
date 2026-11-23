import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { Markdown } from "../../src/web/components/markdown.tsx";
import { Reasoning } from "../../src/web/components/reasoning.tsx";

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
