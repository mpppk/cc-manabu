#!/usr/bin/env bun
/**
 * 単一バイナリをビルドする（bun-cli-webui skill の build）。
 *
 *   bun run build:binary                      # このマシン向け
 *   BUN_TARGET=bun-darwin-arm64 bun run build:binary
 *   OUTFILE=dist/cc-manabu bun run build:binary
 *
 * Web UI（src/web/index.html から辿れる JS・CSS・チャンク）はバイナリに埋め込まれる。
 * Claude Code 本体は埋め込まず、利用者の `claude` を使う（docs/spikes/compile-agent-sdk.md）。
 */
import tailwind from "bun-plugin-tailwind";

type Target = NonNullable<
  Extract<
    Parameters<typeof Bun.build>[0]["compile"],
    { target?: unknown }
  >["target"]
>;

// 未指定ならこのマシン向け（target を渡さない）
const target = Bun.env.BUN_TARGET as Target | undefined;
const outfile =
  Bun.env.OUTFILE ??
  (target?.includes("windows") === true ? "./cc-manabu.exe" : "./cc-manabu");

const result = await Bun.build({
  entrypoints: ["./src/binary.ts"],
  compile: target === undefined ? { outfile } : { target, outfile },
  plugins: [tailwind],
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
console.log(`built ${outfile} (${target ?? "native"})`);
