# Spike: インストールした artifact から claude を動かす（B 案）

cc-manabu の CLI とローカルサーバをなくし、Claude デスクトップアプリの「Install as app」でインストールした artifact から、利用者の `claude` を子プロセスとして直接動かせるかを確かめます。

- artifact のソース: [`spikes/desktop-artifact/desktop-spike.html`](../../spikes/desktop-artifact/desktop-spike.html)
- 使う API: artifact の `desktop` capability（`full-access` で `fs` / `childProcess`、`notifications`）

## 背景: Agent SDK がしていること

Agent SDK（0.3.330）の `query()` は、`claude` を次の引数で起動し、標準入出力で JSON Lines をやりとりしているだけです。

```
claude --output-format stream-json --verbose --input-format stream-json \
  [--include-partial-messages] [--permission-prompt-tool stdio] \
  [--resume <id>] [--resume-session-at <uuid>] [--fork-session] \
  [--add-dir <dir>]... [--setting-sources user,project,local] [--effort <level>] [--model <m>]
```

cc-manabu が使っている SDK のオプションは、すべて CLI のフラグか制御メッセージに対応します。

| SDK のオプション | CLI / プロトコル |
| --- | --- |
| `resume` / `resumeSessionAt` / `forkSession` | `--resume` / `--resume-session-at` / `--fork-session` |
| `additionalDirectories` | `--add-dir`（複数回） |
| `settingSources` | `--setting-sources` |
| `effort` | `--effort` |
| `includePartialMessages` | `--include-partial-messages` |
| `canUseTool` | `--permission-prompt-tool stdio` と `can_use_tool` の control_request |
| `interrupt()` / `setModel()` | `interrupt` / `set_model` の control_request |
| `rate_limit_event`、`result` の usage・cost | stdout にそのまま流れる |

SDK のブラウザ版（`@anthropic-ai/claude-agent-sdk/browser`）は WebSocket と SSE にしか対応しておらず、子プロセスの標準入出力には使えません。B 案では、この JSON Lines の層をページ側で実装します。

### 制御プロトコル（SDK の実装から抜き出したもの）

```jsonc
// → 起動直後に送る
{"request_id":"<id>","type":"control_request","request":{"subtype":"initialize"}}
// ← 応答（commands, agents, models, account.subscriptionType, claude_code_version, pid, ...）
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{...}}}

// → 発言
{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"..."}]},"parent_tool_use_id":null}

// ← ツールの承認を求められる
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{...},"description":"...","tool_use_id":"toolu_...","decision_reason_type":"rule", ...}}
// → 許可（拒否は {"behavior":"deny","message":"..."}）
{"type":"control_response","response":{"subtype":"success","request_id":"<uuid>","response":{"behavior":"allow","updatedInput":{...},"toolUseID":"toolu_..."}}}

// ← 取り消し（承認カードを閉じる）
{"type":"control_cancel_request","request_id":"<uuid>"}
// → 中断・モデル切替
{"request_id":"<id>","type":"control_request","request":{"subtype":"interrupt"}}
{"request_id":"<id>","type":"control_request","request":{"subtype":"set_model","model":"sonnet"}}
```

対応していない control_request には `{"subtype":"error","request_id":...,"error":"..."}` で応答します（SDK と同じ）。

## 結果（開発用コンテナでの事前確認）

Node から上のプロトコルで `claude`（Claude Code 2.1.332 / haiku）を直接動かしました。

| 確認したこと | 結果 |
| --- | --- |
| `initialize` の control_request | 0.5 秒で応答。models 16 件、`account.subscriptionType`、`claude_code_version` が取れる |
| 発言を stdin に書く | `system/init` → `stream_event` → `assistant` → `result` の順に流れる |
| `rate_limit_event` | 5 時間・7 日の `utilization` 付きで届く |
| `result` | `total_cost_usd`、usage、`session_id` が取れる |
| `--permission-prompt-tool stdio` と ask ルール（`--settings` で `permissions.ask: ["Bash"]`） | `can_use_tool` が届き、allow を返すとツールが実行された |
| stdin を閉じる | `result` のあとプロセスが exit 0 で終わる |

ask ルールがない場合、この環境では Bash が自動で許可され、`can_use_tool` は来ませんでした。承認の流れを確かめるために、artifact では「Bash・Write・Edit を毎回確認する」設定ファイルを `--settings` で渡しています（既定でオン）。

## 利用者の手元で確認すること（artifact）

デスクトップ API は、インストールしたアプリのウィンドウの中でしか動きません。以下は artifact を使って手元で確かめ、結果をこの文書に追記します。

1. **claude を見つける**: アプリの環境・ログインシェル（`-lc`）・対話ログインシェル（`-lic`）で `command -v claude` と `claude --version` を試し、どれで見つかるかを比べる
2. **制御プロトコル**: initialize、ストリーミング、承認（長く待ってから許可しても動くか）、`interrupt`、`set_model`、`--resume` を、ページの中だけで行う
3. **ウィンドウを閉じても動き続けるか**: 心拍を書き続けるプロセスを plain（`&`）・`nohup`・`setsid`（なければ `perl -MPOSIX`）の 3 方式で起動し、ウィンドウを閉じる・アプリを終了したあとに残るかを見る。`claude -p` を切り離して実行し、閉じている間に完走するかも見る

結果は `~/.cc-manabu-spike/results.json` に保存され、artifact の「結果のまとめ」に Markdown で出ます。stream-json の生ログは `~/.cc-manabu-spike/protocol-*.jsonl` に残るので、Provider のテストの fixture にも使えます。

### 手元での結果

（未記入。artifact の「まとめをコピー」の内容をここに貼る）
