# Spike: モデル一覧・アカウント情報・ログイン状態（#16）

`scripts/spikes/models-and-auth.ts` を実機（Agent SDK 0.3.330 / Claude Code 2.1.330）で実行した結果です。

## プロンプトを送らずに情報を取る

`query()` に「何も yield しない AsyncIterable」を prompt として渡すと、Claude Code のプロセスが起動し、制御メソッドが使える状態で待機する。この状態で次のメソッドを呼べる（約 0.7 秒）。

| メソッド | 取れるもの |
| --- | --- |
| `q.supportedModels()` | `ModelInfo[]`: `value`（`default` / `opus` / `sonnet` / `fable` / `haiku` / フル ID）、`displayName`、`resolvedModel`、`supportsEffort`、`supportedEffortLevels`、`supportsAdaptiveThinking` など |
| `q.accountInfo()` | `email`、`organization`、`subscriptionType`、`tokenSource`、`apiKeySource`、`apiProvider` |
| `q.initializationResult()` | 上記に加えて `commands`、`agents`、`claude_code_version`、`current_permission_mode` など |

使い終わったら入力を閉じ、`q.return()` でプロセスを終了する。

この環境で取れたモデル（抜粋）:

```
default (Default (recommended)) → claude-opus-5-5   effort: low/medium/high/xhigh/max
opus    (Opus 5.5)              → claude-opus-5-5
sonnet  (Sonnet 5.5)            → claude-sonnet-5-5
fable   (Fable 5.2)             → claude-fable-5-2
haiku   (Haiku 5.5)             → claude-haiku-5-5
claude-haiku-4-5-20251001 (Haiku 4.5)  effort: なし
…（旧モデルのフル ID が続く）
```

## 設計への反映

### モデルと effort の選択 UI（#40）

- サーバ起動時に 1 回、上記の方法で `supportedModels()` を取り、キャッシュして oRPC（`system.models`）で返す。ハードコードしない。
- effort の選択肢は、モデルごとの `supportedEffortLevels` を使う（対応しないモデルでは effort 欄を出さない）。
- 既定のモデルは `default`。

### thinking の表示（#20・#37）

| 指定 | thinking ブロック | 本文（`thinking_delta`） |
| --- | --- | --- |
| `thinking: { type: "adaptive", display: "summarized" }` | あり | **届く**（sonnet・haiku とも） |
| `thinking: { type: "adaptive" }`（display 指定なし） | あり | 届かない（推定トークン数のみ） |

- Provider は `thinking: { type: "adaptive", display: "summarized" }` を既定にし、`thinking_delta` を reasoning として流す。
- #12 の fixture（`type: "enabled"`、haiku）では本文が空だった。`display` は `adaptive` と組み合わせて使う。

### ログイン状態の確認（#32）

- `claude` が見つからない場合: `query()` の呼び出し直後に `Claude Code native binary not found at <path>…` という例外になる（約 20 ms）。起動時に検出して案内できる。
- 未ログインの場合: **この環境ではホスト側が認証するため再現できなかった**（環境変数を空にしても認証された）。型定義から分かることは次のとおり:
  - 応答の `assistant` メッセージの `error` に `SDKAssistantMessageError`（`authentication_failed`、`oauth_org_not_allowed`、`account_on_hold`、`billing_error`、`rate_limit`、`overloaded`、`model_not_found` など）が入る。
  - `auth_status` メッセージ（`isAuthenticating`、`output`、`error`）がある。
  - 起動時は `accountInfo()` の `subscriptionType` / `tokenSource` / `apiKeySource` で、ログイン方法をある程度判別できる見込み。
  - **未ログインの検出は利用者の手元で確認する**（#23 の結合テストに含める）。それまでは「`assistant.error` が `authentication_failed` なら `claude` でのログインを案内する」実装にしておく。
- この環境の `subscriptionType` は `"Claude API"` だった（クラウド環境のため）。利用者の手元では、サブスクのログインなら `Claude Pro` / `Claude Max` などになると想定される。
