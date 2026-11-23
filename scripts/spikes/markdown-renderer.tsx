#!/usr/bin/env bun
/**
 * Spike #17: Streamdown の描画とバンドルサイズを確かめる。
 *
 *   bun scripts/spikes/markdown-renderer.tsx
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToString } from "react-dom/server";
import { Markdown } from "../../src/web/components/markdown.tsx";

const cases: Record<string, string> = {
  gfm: "| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~strike~~",
  "unclosed code block": "説明します。\n\n```ts\nconst a = 1;\nconst b",
  "unclosed bold": "これは **重要",
  "math (complete)": "質量とエネルギー: $$E = mc^2$$",
  "math (unclosed)": "式: $$\\int_0^1 x",
  "cjk emphasis": "**「重要」**です。",
  mermaid: "```mermaid\ngraph TD; A-->B;\n```",
};

for (const [name, text] of Object.entries(cases)) {
  const html = renderToString(<Markdown text={text} streaming />);
  console.log(
    `\n## ${name}\n${html.slice(0, 400)}${html.length > 400 ? "…" : ""}`,
  );
}

const outdir = await mkdtemp(path.join(tmpdir(), "cc-manabu-md-"));
// 依存を解決できるよう、エントリはプロジェクト内に置く
const entry = path.join(import.meta.dir, "markdown-renderer.entry.tsx");
const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "browser",
  minify: true,
  splitting: true,
});
if (!result.success) {
  console.log(result.logs);
}
const sizes = result.outputs.map((o) => o.size);
const total = sizes.reduce((a, b) => a + b, 0);
console.log(
  `\n## bundle\nfiles: ${result.outputs.length}, entry: ${((result.outputs.find((o) => o.kind === "entry-point")?.size ?? 0) / 1024) | 0} KiB, total: ${(total / 1024 / 1024).toFixed(1)} MiB`,
);
await rm(outdir, { recursive: true, force: true });
