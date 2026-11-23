# Spike: SDKMessage の観察（#12）

`scripts/record-sdk-messages.ts` で、実機の `query()` が返す SDKMessage 列を `test/fixtures/sdk-messages/*.jsonl` に記録しました。
ここでは、自前 Provider（#18〜#22）の設計に効く観察をまとめます。

- 記録環境: `@anthropic-ai/claude-agent-sdk` 0.3.330、Claude Code 2.1.330、モデル `haiku`（`claude-haiku-5-5`）
- 共通オプション: `settingSources: []`、`tools: []`（シナリオごとに上書き）、`maxTurns: 3`
- 再記録: `bun run record:fixtures [scenario...]`（サブスクの利用枠を少し使う）

## fixture 一覧

| ファイル | 内容 |
| --- | --- |
| `text-partial.jsonl` | テキストのみ、`includePartialMessages: true` |
| `text-no-partial.jsonl` | テキストのみ、`includePartialMessages: false` |
| `thinking.jsonl` | `thinking: { type: "enabled", display: "summarized" }`、`effort: "high"` |
| `tool-read.jsonl` | `Read` を `allowedTools` で自動許可 |
| `tool-error.jsonl` | 存在しないファイルを `Read`（`is_error: true` の tool_result） |
| `tool-permission-deny.jsonl` | `canUseTool` で `Bash`（`touch`）を拒否 |
| `tool-permission-allow.jsonl` | `canUseTool` で `Bash`（`touch`）を許可 |
| `*.can-use-tool.json` | 上の 2 シナリオで `canUseTool` に渡された引数 |
| `abort.jsonl` | 最初の `content_block_delta` の直後に `abort()`。末尾の `__error__` は `query()` が投げた例外（記録用の擬似メッセージ） |
| `resume-turn1.jsonl` / `resume.jsonl` | 1 ターン目と、`resume` した 2 ターン目 |

`system/init` は実行環境に依存する値が多いため、Provider が使うキー（`cwd`、`session_id`、`tools`、`model`、`permissionMode` など）だけを残しています。パスは `/tmp/cc-manabu-fixture` などに置き換えています。

## 1 ターンの流れ（text-partial）

```
active_goal / autocompact_state      ← 情報用。無視してよい
system(init)                         ← session_id, model, tools
system(status)                       ← 情報用
stream_event(message_start)
stream_event(content_block_start: text)
stream_event(content_block_delta: text_delta) × n
assistant                            ← 完成したブロック（1 ブロック 1 メッセージ）
stream_event(content_block_stop)
stream_event(message_delta / message_stop)
rate_limit_event                     ← サブスクの利用状況（five_hour / seven_day の utilization）
system(post_turn_summary)            ← 情報用（クラウド環境由来の可能性あり）
result(success)                      ← usage, total_cost_usd, modelUsage, stop_reason, permission_denials
```

## Provider への示唆

### ストリームの変換

- テキストは `stream_event` の `content_block_start` / `content_block_delta(text_delta)` / `content_block_stop` を、`index` ごとに `text-start` / `text-delta` / `text-end` に変換すればよい。
- **`assistant` メッセージはブロック単位で届き**、`content_block_stop` より先に来る。partial を使う場合、テキストと thinking は `assistant` を無視して `stream_event` だけで組み立てる。
- `tool_use` は `input_json_delta` で入力が流れたあと、`assistant` メッセージに完成した入力が載る。`tool-call` は `assistant` の `tool_use` ブロックから出すのが簡単で確実。
- ツールの結果は `user` メッセージの `tool_result` ブロック。`is_error: true` ならエラー。`tool_use_result` に構造化された結果（Read ならファイル情報）も付く。
- `parent_tool_use_id` が非 null のメッセージはサブエージェント内のもの（今回の fixture にはない）。MVP では表示対象外にするか、ツールカードの中に入れるかを決める必要がある。
- 未知の `type` / `subtype`（`active_goal`、`autocompact_state`、`rate_limit_event`、`system(status / task_summary / post_turn_summary / thinking_tokens)` など）は多数あるので、**ホワイトリスト方式で必要なものだけ処理し、他は無視する**。

### thinking

- `display: "summarized"` を指定しても、haiku では thinking ブロックのテキストが空で、`signature_delta` だけが届いた。代わりに `system(thinking_tokens)` が推定トークン数を逐次通知する。
- UI では「考え中（N トークン）」のような表示を基本にし、テキストがあれば reasoning として出す。モデルごとの差は #16 で追加確認する。
- `thinking: { type: "adaptive" }` では、簡単な質問だと thinking 自体が発生しなかった。

### 中断（abort）

- `abortController.abort()` の後も、**`query()` はバッファ済みの `stream_event` を 100 件近く流し続け**、最後に `name: "Error"`、`message: "Claude Code process aborted by user"` の例外を投げた。`AbortError` ではない。
- `result` メッセージも、完成した `assistant` メッセージも届かない。
- Provider は abort 後に自分で出力を止め（`signal.aborted` を見て以降のメッセージを捨てる）、例外は中断として扱う必要がある。
- 中断したターンの途中の応答がセッションにどう残るか（resume 時に見えるか）は #13 で確認する。

### 承認（canUseTool）

- `echo hi` のような読み取り専用のコマンドは Claude Code が自動で許可し、`canUseTool` は呼ばれなかった。`touch` のような変更系では呼ばれた。
- `canUseTool` の第 3 引数には `suggestions`（`addRules` / `addDirectories` / `setMode`）、`blockedPath`、`displayName`、`description`、`toolUseID`、`requestId` が入る。UI の承認ダイアログに十分な情報がある。
- 拒否すると、`message` がそのまま `is_error: true` の tool_result になり、`result.permission_denials` にも記録される。

### resume

- `resume: <session_id>` の 2 ターン目でも `session_id` は変わらなかった（fork しない限り同じ ID を使い続ける）。文脈も引き継がれた。

### usage とコスト

- `result` に `usage`（input / output / cache_read / cache_creation）、`total_cost_usd`、`modelUsage`（モデルごとの内訳）、`duration_ms`、`duration_api_ms`、`terminal_reason` がある。UI の使用量表示はここから作れる。
- `rate_limit_event` でサブスクの 5 時間枠・7 日枠の利用率が取れる。UI に出す価値がある（MVP 以降の候補）。
