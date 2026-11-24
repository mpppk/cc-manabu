# サブスクリプションの利用枠（#116）

Agent SDK 0.3.330 と、Claude サブスクリプションでログインした Claude Code で確認した（2026-11）。

## 取得できるもの

`query()` のメッセージに `rate_limit_event` が回答ごと（`result` の前）に 1 回届く。
型（`SDKRateLimitInfo`）には、いちばん厳しい枠の `status` / `resetsAt`（UNIX 秒）/ `rateLimitType` / `utilization` がある。
実機ではさらに、型に無い `unifiedWindows` に枠ごとの利用率とリセット時刻が入っていた。

```json
{
  "status": "allowed",
  "resetsAt": 1795494000,
  "rateLimitType": "five_hour",
  "overageStatus": "rejected",
  "overageDisabledReason": "org_level_disabled",
  "isUsingOverage": false,
  "unifiedWindows": {
    "five_hour": { "utilization": 0.62, "resetsAt": 1795494000, "status": "allowed" },
    "seven_day": { "utilization": 0.67, "resetsAt": 1795633200, "status": "allowed" }
  }
}
```

- 用語抽出などの軽い呼び出しでも届く。モデル（haiku / default）で値は変わらなかった
- `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` でも `/usage` 相当の値が取れるが、
  名前のとおり不安定な API なので使わない
- 回答しないと届かない。起動直後や長く使っていないときの値は分からない

## 使い方

- provider の `onRateLimit` で受け取り、表示用の形（`src/chat/rate-limit.ts`）にして `app_state` テーブルに保存する
  （サーバを再起動しても最後の観測を表示できる）
- `unifiedWindows` は型に無いので、あれば使い、無ければ型にある 1 つの枠だけを使う。形が違う値は読み飛ばす
- 画面（ヘッダー）には、いちばん使っている枠の利用率とリセット時刻を出し、ツールチップに枠ごとの値と最終確認の時刻を出す
  - 80% 以上か `allowed_warning` なら注意の色、`rejected` なら「利用上限」
  - リセット時刻を過ぎた枠の値は古いので「リセット済み」とする
- まだ観測していなければ何も出さない
