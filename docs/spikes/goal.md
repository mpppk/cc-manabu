# Spike: Agent SDK からネイティブの `/goal` を使う（#198）

`scripts/spikes/goal.ts` を実機（Agent SDK 0.3.330 / Claude Code 2.1.330 / haiku）で実行した結果です。

## 起動

- `query({ prompt: "/goal <条件>" })` でネイティブの `/goal` が動く。最初に assistant メッセージとして `Goal set: <条件>` が届き、続けてゴールに向けたターンが始まる（Claude Code が「ゴールを確認し、ユーザーに尋ねずに取りかかる」という meta のユーザーメッセージを足す）
- 1 回の `query()`（`-p` 相当）でゴールのループが終わるまで走り、最後に通常の `result`（`subtype: "success"`, `stop_reason: "end_turn"`）が届く
- **`result` やストリームのメッセージには、達成・達成不能の判定は出ない**。正常に終わったことしか分からない

## 判定の記録

判定はセッションの記録（`~/.claude/projects/<cwd を変換した名前>/<session_id>.jsonl`）の `attachment` に残る。

| 状況 | 記録 |
| --- | --- |
| ゴールを設定した | `{"type":"goal_status","met":false,"sentinel":true,"condition":"…"}` |
| 達成 | `{"type":"goal_status","met":true,"condition":"…","reason":"…","iterations":1,"durationMs":6282,"tokens":327}` |
| 達成不能 | `{"type":"goal_status","met":false,"failed":true,"condition":"…","reason":"…","iterations":1,…}` |

- 評価の直後に `system` / `stop_hook_summary` の行が残る
- 未達成のまま続くターンでは `met: false`（`failed` なし）が残ると考えられる（公式ドキュメントの「Not yet met」）。今回の 2 ケースでは 1 回目で判定が出た

## ストリームで分かること

- 各ターンの終わりに `system` / `post_turn_summary` が届く。`status_category`（`completed` / `review_ready` など）、`status_detail`（要約）、`needs_action`（利用者の対応が必要なとき）を持つ。達成不能のケースでは `status_category: "review_ready"`、`status_detail: "… goal unachievable"` だった
- ツールの承認待ちは、従来どおり `canUseTool` で分かる

## 実装への反映

- ゴールの実行は、新しいスレッドの最初のメッセージを `/goal <ゴール>` にして、既存の送信経路（承認・中断・保存）で走らせる
- 判定は、生成が終わったあとにセッションの記録から最後の `goal_status`（`sentinel` 以外）を読んで決める。`met: true` なら完了、`failed: true` なら保留（理由を残す）、どちらでもなければ要確認
- 生成中の承認待ちは要確認、承認されて再開したら進行中に戻す
