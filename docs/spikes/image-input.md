# Spike: 画像を Claude Code に渡す（#99）

`scripts/spikes/image-input.ts` を実機（Agent SDK 0.3.330 / Claude Code 2.1.330 / haiku）で実行した結果です。

## 渡し方

`query()` の `prompt` は `string | AsyncIterable<SDKUserMessage>`。画像は文字列では渡せないので、Messages API と同じ content ブロックを持つ `SDKUserMessage` を 1 つ流す AsyncIterable にする。

```ts
const message: SDKUserMessage = {
  type: "user",
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data } },
      { type: "text", text: "この画像は？" },
    ],
  },
};
query({ prompt: (async function* () { yield message; })(), options });
```

メッセージを 1 つ流して iterable を終えると、そのターンの `result` まで流れてから `query()` が終わる（文字列の prompt と同じ）。

## シナリオと結果

| 手順 | 内容 | 結果 |
| --- | --- | --- |
| 1 | 新規セッション。赤地に「7」の PNG と質問 | 「背景色は赤、文字は 7」 |
| 2 | `resume` して、青地に「K」の PNG と質問 | 「背景色は青、文字は K」（session ID は同じ） |
| 3 | `resume` して、画像なしで「最初の画像の文字は？」 | 「7」。**前のターンの画像はセッションに残る** |

## 実装への反映

- Provider は、画像が無ければ従来どおり文字列、あれば上の AsyncIterable を渡す（`toQueryPrompt`）
- 履歴の画像はセッションが持つので、送るのは末尾の発話の画像だけ。fork（再生成・編集）でも分岐点までの画像はセッションに残る
- 形式は Claude が受け付ける PNG / JPEG / GIF / WebP。1 枚 5MB まで（API の上限）。長辺 1568px を超える画像は Claude 側でも縮小されるので、ブラウザで縮小してから送る
