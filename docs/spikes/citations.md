# 回答の出典（#258）

Claude Code の Web 検索の結果と、回答の本文の出典の対応を、Agent SDK の実際のストリームで確かめた（2026-11-28、Claude Code 2.1.332、haiku）。

## 構造化された引用は付かない

- `WebSearch` ツールは Claude Code の中で別の呼び出しとして動き、結果は `tool_result` の文字列で返る
- メインの会話の assistant の `text` ブロックには `citations` が付かない（Claude API のストリーミング引用は使えない）
- `tool_result` の文字列はこの形（`tool_use_result` にも同じ `results` が入る）

```
Web search results for query: "official Bun website bun.sh"

Links: [{"title":"bun.sh","url":"https://bun.sh/1.0"},{"title":"Welcome to Bun","url":"https://bun.sh/docs"}, …]

（結果の要約の文章）
```

- 本文に Claude が書く URL は、検索結果の URL とそろうとは限らない（例: 結果は `https://bun.sh/docs` で、本文は `https://bun.sh`）

## 方針

- 出典と本文の対応は、Claude が本文に付けた印で決める。システムプロンプトに `CITATION_INSTRUCTIONS`（`src/chat/citations.ts`）を足し、根拠にした文・項目の末尾に `[出典](URL)` を付けてもらう。Wiki はこれまでどおり `[タイトル](wiki:ページID)`
- 印の URL が、その回答のツールの結果（WebSearch の `Links`、WebFetch の URL、Slack のパーマリンク、Cosense のページなど）に実際にあるときだけ出典にする。無い URL は通常のリンクのまま
- 番号を付けた出典は、回答を保存するときに `metadata.citations` に残す。ストリーミング中は同じ関数で、今ある本文とツールの結果から求める

## 実機での確認

`CITATION_INSTRUCTIONS` を足して「Web で検索して、Bun の公式ドキュメントの URL と Bun が何かを 2 文で教えて」と送ると、2 つの文の末尾にそれぞれ `[出典](https://bun.com/docs)`・`[出典](https://docsearch.algolia.com/…/bun.sh)` が付き、どちらも検索結果にあったので出典 1・2 になった（`MONET_LIVE=1 bun test test/live/provider.test.ts -t "#258"`）。

Slack・Cosense は利用者の環境の MCP サーバ次第なので、E2E では実機の結果の形にそろえた台本（`test/e2e/scripted-query.ts` の「出典を付けて」）で確かめている。Slack はパーマリンク（`permalink`）とチャンネル名・本文、Cosense はページを読むツールの入力（プロジェクトとページ名）か結果の URL から出典にする。
