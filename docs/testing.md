# テスト

| 種類 | コマンド | CI | 内容 |
| --- | --- | --- | --- |
| 単体テスト | `bun test` | 実行する | Provider は記録済みの SDKMessage（`test/fixtures/sdk-messages/`）を流す fake query で検証する |
| E2E テスト | `bun run test:e2e` | 実行する | Playwright で本物の Web UI を動かす。Claude はモック（`test/e2e/scripted-query.ts` の台本どおりに応答する）。送信、リロード後の再開、承認、停止・再生成・編集、会話の管理を確認する |
| 実機の結合テスト | `bun run test:live` | 実行しない | 実際の `claude` を使う。`MONET_LIVE=1` のときだけ動き、普段の `bun test` では skip される |

## 実機の結合テスト（`test/live/`）

前提: `claude` がインストールされていて、ログイン済みであること。haiku を使い、サブスクの利用枠を少し消費する（1 回あたり 30 秒ほど）。

確認している内容:

- テキストの応答、`resume` による文脈の引き継ぎ、`resumeSessionAt` ＋ `forkSession` による巻き戻し
- 承認が必要なツール（`Bash` の `touch`）が `canUseTool` を通り、拒否・許可が実際に反映される
- ストリーミングで `dynamic-tool` パーツとテキストが届く
- 中断するとエラーにならずに止まる
- タスクのスレッド（Wiki ページの会話とふつうのスレッド）で、Claude が in-process の MCP サーバ（`wiki`）のツールを使い、承認のうえでページを編集・作成する（読むツールは承認なし）
- 回答のあとに入力を開けたまま `getContextUsage({ detail: "summary" })` でコンテキストの使用量を取り、取り終えたら終わる（#245）。回答の最後の uuid がセッションの記録（`getSessionMessages`）に見つかる（#244）
- Web 検索の結果を根拠にした文の末尾に `[出典](URL)` が付き、その URL が検索結果にあるので出典になる（#258、docs/spikes/citations.md）

Agent SDK や Claude Code を更新したときに実行する。

## fixture の再記録

```sh
bun run record:fixtures            # すべてのシナリオ
bun run record:fixtures abort      # 指定したシナリオだけ
```

記録後は `git diff test/fixtures` で差分を確認し、`bun test` が通ることを確かめる。メッセージの形が変わっていたら `docs/spikes/sdk-messages.md` も更新する。

## 手元でしか確認できないこと

開発環境（クラウド）では再現できなかったため、利用者の手元で一度確認する。

- [ ] 未ログインの状態で送信すると、`ClaudeCodeApiError`（`authentication_failed`）になり、ログインを案内できる（docs/spikes/models-and-auth.md）
- [ ] `~/.claude/settings.json`（user 設定）の `permissions.allow` に一致するツールは、承認ダイアログを出さずに実行される（docs/spikes/permissions.md）
- [ ] サブスクのログインで `accountInfo().subscriptionType` が `Claude Pro` / `Claude Max` などになる
