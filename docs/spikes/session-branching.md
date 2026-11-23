# Spike: resume / resumeSessionAt / forkSession の挙動（#13）

`scripts/spikes/session-branching.ts` を実機（Agent SDK 0.3.330 / Claude Code 2.1.330 / haiku）で実行した結果です。

## シナリオと結果

| 手順 | 内容 | 結果 |
| --- | --- | --- |
| turn1 | 新規。「合言葉は りんご」 | session `S`、assistant uuid `A1` |
| turn2 | `resume: S`。「合言葉を みかん に変更」 | session は `S` のまま、assistant uuid `A2` |
| fork | `resume: S, resumeSessionAt: A1, forkSession: true`。「今の合言葉は？」 | **新しい session `S'`**。答えは「りんご」（turn2 が無かったことになる） |
| 分岐元 | `resume: S`。「今の合言葉は？」 | 「みかん」。**分岐元のセッションは壊れない** |
| 中断 | `resume: S` で長い出力を頼み、最初の delta で abort | `Claude Code process aborted by user` |
| 中断後 | `resume: S`。「直前の返答はどこまで？」 | 「400」（実際は 1 しか出ていない）。**途中までの応答はモデルに見えていない** |

`getSessionMessages(S'）` の中身（fork 先）:

```
user      9447…  合言葉は「りんご」です…        ← 分岐元と同じ uuid を共有する
assistant 2d69…  OK                             ← A1（resumeSessionAt に指定した地点）
user      3b9e…  今の合言葉を単語だけで…        ← ここから新しい枝
assistant 14f0…  りんご
```

## 分かったこと

1. **再生成と編集は `resume` ＋ `resumeSessionAt` ＋ `forkSession: true` で実現できる。**
   - 分岐点は「やり直すターンの直前のターンの、最後の assistant メッセージの uuid」。
   - fork すると新しいセッション ID が発行される。fork した地点までの履歴（uuid も同じ）を引き継ぐ。
   - 分岐元のセッションはそのまま残る。不要になったら `deleteSession` で消せる。
2. **ストリームにはユーザー発話の uuid が流れない**（prompt を文字列で渡した場合）。`getSessionMessages(sessionId)` を読めば取れるが、分岐点の指定に必要なのは assistant の uuid だけなので、ストリーム中の `assistant` メッセージの uuid を記録すれば足りる。
3. **最初の発話を編集する場合は、分岐点が無い**。新規セッションとして送り直す（`resume` を付けない）。
4. **中断したターンは、ユーザー発話だけがセッションに残り、途中までの応答は残らない。** resume すると、モデルは「質問に答えずに終わった」状態から続ける。
   - UI では途中までの応答を「中断」と表示しつつ、モデルにはその内容が見えていないことを前提にする。
   - Claude Code 本体も中断時は同様の挙動なので、MVP ではこのままとする。気になる場合は、次の送信時に中断前の地点から fork する方式も取れる（後で検討）。
5. `resumeSessionAt` には `resumeDropsTurn` という検証用オプションもある。捨てる範囲に想定外のエントリ（ターンの途中で取り込まれたメッセージなど）があれば、resume を拒否する。MVP では使わず、問題が出たら検討する。

## 設計への反映（#28・#30 向け）

- `messages` テーブル（開発計画 §2.5）の assistant 行に、**そのターンで最後に届いた `assistant` メッセージの uuid** を `sdk_uuid` として保存する。ツールを使うと 1 ターンに複数の assistant メッセージが届くので、最後のものを使う。
- 再生成（最後の応答）: 1 つ前の assistant 行の `sdk_uuid` を `resumeSessionAt` にして fork し、同じユーザー発話を送り直す。1 つ前が無ければ新規セッションにする。
- 編集（n 番目のユーザー発話）: その発話の直前の assistant 行の `sdk_uuid` で fork し、編集後のテキストを送る。直前が無ければ新規セッションにする。
- fork 後は `chats.session_id` を新しい ID に差し替える。古いセッションは、MVP では消さずに残す（分岐 UI を後で作るときに使える）。
- 会話を削除するときは、`deleteSession` で Claude Code 側のセッションも消すかを選べる（#26 で判断）。
