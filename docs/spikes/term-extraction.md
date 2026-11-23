# Spike: 回答からの用語抽出を軽い呼び出しにする（#80）

`scripts/spikes/term-extraction.ts` を実機（Agent SDK 0.3.330 / Claude Code 2.1.330 / haiku）で実行した結果です。

回答ごとに追加でモデルを呼ぶので、通常の会話と同じ設定（`claude_code` のシステムプロンプト・すべてのツール）だと、1 回あたり 3〜4 万トークンの入力になる。そこで Claude Code の機能を外して呼ぶ。

## 設定

```ts
{
  model: "haiku",
  systemPrompt: TERM_EXTRACTION_SYSTEM_PROMPT, // 文字列で preset を置き換える
  tools: [],                // 組み込みツールをすべて無効にする
  settingSources: [],       // CLAUDE.md・settings.json を読まない
  persistSession: false,    // ~/.claude にセッションを残さない
  maxTurns: 1,
  thinking: { type: "disabled" },
}
```

## 結果

| 項目 | 値 |
| --- | --- |
| 入力（cache 作成を含む） | 約 1,900 トークン |
| 出力 | 136 トークン |
| total_cost_usd | 約 $0.0007 |
| セッションの保存 | なし（`~/.claude/projects` に新しいディレクトリができない） |
| 出力 | `[{"term":"関係タプル","aliases":["relation tuple"],"summary":"…"}]`（そのまま JSON として解析できた） |

## 実装への反映

- 用語抽出は上の設定で、回答の完了後に非同期で呼ぶ（`src/wiki/terms.ts` の `TERM_EXTRACTION_SETTINGS`）
- モデルの出力は信用せず、回答に実際に出てくる語・既存のタイトルや別名と重ならない語だけを残す
- それでも利用枠（API キーなら料金）は消費するので、プロジェクトの設定で止められるようにし、そのことを設定画面に書く
