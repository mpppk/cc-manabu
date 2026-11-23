# Spike: ストリーミング Markdown レンダラの選定（#17）

## 結論

**Streamdown 2（`streamdown`）＋ 公式プラグインを採用する。**

| パッケージ | 役割 |
| --- | --- |
| `streamdown` 2.8 | ストリーミング対応の Markdown（GFM、書きかけの補完、テーブル・コードのコピー） |
| `@streamdown/code` | コードハイライト（shiki） |
| `@streamdown/math` | 数式（KaTeX） |
| `@streamdown/mermaid` | Mermaid 図 |
| `@streamdown/cjk` | 日本語まわりの強調（`**「重要」**です` のような CJK と記号の組み合わせ） |

コンポーネントは `src/web/components/markdown.tsx`（`<Markdown text streaming />`）。#37 でそのまま使う。

## 確認したこと（`scripts/spikes/markdown-renderer.tsx`）

`react-dom/server` の `renderToString` で描画した結果:

| ケース | 結果 |
| --- | --- |
| GFM（テーブル、タスクリスト、取り消し線） | 描画される。テーブルにはコピー用のボタンが付く |
| 閉じていないコードブロック | `data-incomplete="true"` のコードブロックとして描画される（崩れない） |
| 閉じていない太字（`これは **重要`） | 太字として補完される |
| 数式（閉じている / 閉じていない） | どちらも KaTeX で描画される |
| CJK の強調（`**「重要」**です。`） | 太字になる（CommonMark だけでは太字にならないケース） |
| Mermaid | Suspense で遅延描画されるため、サーバでは描画されない。ブラウザで描画される |

## バンドルサイズ

`Bun.build({ target: "browser", minify: true, splitting: true })`:

- 初期ロードのエントリ: **約 660 KiB**
- 遅延読み込みのチャンクを含めた合計: **約 13.6 MiB / 462 ファイル**（大半は shiki の言語・テーマと Mermaid）

localhost で使い、単一バイナリ（約 110 MB）に入れることを考えると許容できる。ただし、遅延読み込みのチャンクがバイナリにすべて埋め込まれ、配信されるかは #43 で確認する。

## Phase 4 で必要な設定（#34・#37）

- Streamdown は Tailwind のユーティリティクラスで装飾されている。Tailwind v4 の CSS で、Streamdown の dist をスキャン対象に入れる:
  ```css
  @import "tailwindcss";
  @source "../../node_modules/streamdown/dist/*.js";
  ```
- KaTeX の CSS を読み込む: `import "katex/dist/katex.min.css";`
- shadcn/ui のテーマ変数（`border`、`sidebar`、`muted-foreground` など）を Streamdown も使うので、shadcn/ui の CSS 変数を先に定義しておく
- ストリーミング中は `streaming`（`isAnimating`）を true にし、完了したら false にする
