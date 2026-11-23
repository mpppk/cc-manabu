# Spike: AI SDK の対象バージョンと LanguageModel spec（#15）

ここに書いた挙動は `test/spikes/ai-sdk-spec.test.ts` でテストとして固定しています。AI SDK を更新したときに前提が崩れれば、このテストが落ちます。

## 採用するバージョン

| パッケージ | バージョン | 用途 |
| --- | --- | --- |
| `ai` | 7.0.x | `streamText`、`toUIMessageStream`、`createUIMessageStream`、`ChatTransport` の型 |
| `@ai-sdk/provider` | 4.0.x | `LanguageModelV4`（`specificationVersion: "v4"`） |
| `@ai-sdk/provider-utils` | 5.0.x | Provider 実装の補助（id 生成など） |
| `@ai-sdk/react` | 4.0.x | `useChat`（Phase 4 で追加） |
| `@orpc/server` / `@orpc/client` | 1.16.x | RPC とストリーミング |

## LanguageModelV4 の要点

- インターフェース: `specificationVersion: "v4"`、`provider`、`modelId`、`supportedUrls`、`doGenerate(options)`、`doStream(options)`
- `doStream` が返す `stream` のパーツ:
  - `stream-start`（warnings）
  - `response-metadata`（id、modelId、timestamp）
  - `text-start` / `text-delta` / `text-end`（id で対応づける）
  - `reasoning-start` / `reasoning-delta` / `reasoning-end`
  - `tool-input-start` / `tool-input-delta` / `tool-input-end`（任意。入力のストリーミング表示用）
  - `tool-call`（`input` は JSON 文字列、`providerExecuted`、`dynamic`）
  - `tool-result`（`result`、`isError`、`dynamic`）
  - `tool-approval-request`（後述）
  - `finish`（usage、`finishReason: { unified, raw }`、providerMetadata）
  - `error`、`raw`、`ping`
- usage は `inputTokens: { total, noCache, cacheRead, cacheWrite }` と `outputTokens: { total, text, reasoning }`
- finishReason の `unified` は `stop` / `length` / `content-filter` / `tool-calls` / `error` / `interrupted` / `other`。中断には `interrupted` が使える

## 検証した挙動

### providerExecuted なツール（Claude Code の組み込みツール）

- `tools` を渡していなくても、`providerExecuted: true, dynamic: true` の `tool-call` と `tool-result` をそのまま受け付ける。1 ステップで完結し、AI SDK 側でツールを実行しようとはしない。
- UIMessage では **`dynamic-tool` パーツ**になり、`toolName`、`toolCallId`、`input`（JSON パース済み）、`output`、`state: "output-available"`、`providerExecuted: true` を持つ。テキストや reasoning との順序も保たれる。
- Provider は Claude Code のツールを常に `providerExecuted: true, dynamic: true` で出せばよい。UI 側は `dynamic-tool` を描画する（#38）。

### providerOptions / providerMetadata

- `streamText({ providerOptions: { "claude-code": {...} } })` は、そのまま `doStream` の `options.providerOptions` に届く。会話ごとの `sessionId`、`resumeSessionAt`、`forkSession`、`effort` はここで渡す（#19）。
- `finish` パーツの `providerMetadata` は、`toUIMessageStream` の `messageMetadata` コールバックでは **`finish-step` パーツから取る**。ストリーム全体の `finish` パーツには `providerMetadata` がない（`totalUsage` はある）。
  - `sessionId`、`costUsd`、分岐用の uuid は `finish-step` で取り出し、UIMessage の metadata に入れる（#28）。

### 独自 data パーツ（承認要求）

- `createUIMessageStream` の `writer.write({ type: "data-approval", id, data })` と `writer.merge(result.toUIMessageStream())` を組み合わせれば、`streamText` の出力に承認要求を差し込める。開発計画 §2.4 の方式で実装できる。
- 補足: V4 には `tool-approval-request` パーツもある。ただしこれは「ストリームを一度終えて、次のリクエストの tool メッセージで承認を返す」前提の仕組みである。`canUseTool` で Claude Code のプロセスを待たせたまま応答を返す今回の構成には合わないため、使わない。

### oRPC での配信

- `os.output(eventIterator(z.custom<UIMessageChunk>())).handler(async function* () { yield* result.toUIMessageStream() })` で、HTTP 越しに UIMessageChunk を流せる（`RPCHandler`＋`RPCLink` で確認）。
- クライアントは `AsyncIterable<UIMessageChunk>` を受け取る。`ChatTransport.sendMessages` / `reconnectToStream` は `ReadableStream<UIMessageChunk>` を返す必要があるので、変換が要る。`ReadableStream.from` は TypeScript の DOM 型定義にないため、小さなヘルパを使う（テスト内の `toReadableStream`）。

## ChatTransport（ai 7.0）

```ts
interface ChatTransport<UI_MESSAGE extends UIMessage> {
  readonly resumeStreamIsReplay?: boolean;
  close?: () => void;
  sendMessages(options: {
    trigger: "submit-message" | "regenerate-message";
    chatId: string;
    messageId: string | undefined;
    messages: UI_MESSAGE[];
    abortSignal: AbortSignal | undefined;
  } & ChatRequestOptions): Promise<ReadableStream<UIMessageChunk>>;
  reconnectToStream(options: {
    chatId: string;
    abortSignal?: AbortSignal;
  } & ChatRequestOptions): Promise<ReadableStream<UIMessageChunk> | null>;
}
```

- `trigger: "regenerate-message"` と `messageId` で再生成を区別できる。`chat.regenerate` への振り分けに使う（#30、#41）。
- `resumeStreamIsReplay: true` は「再接続時にストリームを最初から流し直す」ことを示すフラグと思われる。ChatRunner はバッファを先頭から再送する設計（§2.3）なので、`true` にする想定。Phase 4（#35）で挙動を確認する。
- `abortSignal` は `useChat` の `stop()` で abort される。サーバ側の生成は止めない設計なので、`stop()` では `chat.stop` を明示的に呼ぶ（§2.3）。

## 開発計画への反映

- §2.2: 対象は AI SDK 7 / `LanguageModelV4`。ツールは `providerExecuted: true, dynamic: true` で出す。metadata は `finish-step` から取る。
- §2.4: 承認は `data-approval` パーツで実装する（`tool-approval-request` は使わない）。
