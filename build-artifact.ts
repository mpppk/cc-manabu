#!/usr/bin/env bun
/**
 * デスクトップアプリ版（artifact）をビルドする。
 *
 *   bun run build:artifact      # dist/artifact に出力
 *
 * 出力:
 * - index.html: artifact のページ（publish 時に <html>・<head>・<body> で包まれる断片）
 * - app.js・chunks/: Web UI と、ページの中で動かすサーバ側のコード
 * - app.css・assets/: Tailwind と KaTeX のフォント
 *
 * Agent SDK は Node で動くので、ブラウザ向けのスタブに置き換える（src/desktop/agent-sdk-stub.ts）。
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import type { BunPlugin } from "bun";
import tailwind from "bun-plugin-tailwind";

const outdir = path.resolve(Bun.env.OUTDIR ?? "dist/artifact");

const browserStubs: BunPlugin = {
  name: "cc-manabu-browser-stubs",
  setup(build) {
    build.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
      path: path.resolve("src/desktop/agent-sdk-stub.ts"),
    }));
  },
};

await rm(outdir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["./src/desktop/main.tsx", "./src/web/styles.css"],
  outdir,
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  naming: {
    entry: "[name].[ext]",
    chunk: "chunks/[name]-[hash].[ext]",
    asset: "assets/[name]-[hash].[ext]",
  },
  plugins: [tailwind, browserStubs],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// artifact に publish できるのは U+FFFD（置換文字）を含まないテキストだけなので、
// JS の中のそれ（文字列リテラルと正規表現の中だけにある）を同じ値のエスケープに置き換える
for (const output of result.outputs) {
  if (!output.path.endsWith(".js")) continue;
  const text = await Bun.file(output.path).text();
  if (text.includes("\uFFFD")) {
    await Bun.write(output.path, text.replaceAll("\uFFFD", "\\uFFFD"));
  }
}

// artifact のページ。<title> とマニフェスト（使う権限）を先頭に置く
const page = `<title>cc-manabu</title>
<script type="application/json" id="claude-artifacts-manifest">{"permissions": ["full-access", "notifications"]}</script>
<link rel="stylesheet" href="styles.css">
<style>html, body, #root { height: 100%; } body { background: var(--background); }</style>
<div id="root"></div>
<script type="module" src="main.js"></script>
`;
await Bun.write(path.join(outdir, "index.html"), page);

let total = 0;
for (const output of result.outputs) {
  total += output.size;
  console.log(
    `${path.relative(outdir, output.path).padEnd(48)} ${(output.size / 1024).toFixed(0).padStart(6)} KB`,
  );
}
console.log(`built ${outdir} (${(total / 1024 / 1024).toFixed(1)} MB)`);
