# Spike: canUseTool と permission ルールの評価順（#14）

`scripts/spikes/permissions.ts` を実機（Agent SDK 0.3.330 / Claude Code 2.1.330 / haiku）で実行した結果です。fixture 記録時（#12）の観察も合わせてまとめます。

## 結果

| ケース | `canUseTool` | 結果 |
| --- | --- | --- |
| `.claude/settings.json`（project）の **deny** に一致 | 呼ばれない | 拒否。tool_result は `is_error: true`、`permission_denials` に記録 |
| `.claude/settings.json`（project）の **allow** に一致 | **呼ばれる** | `canUseTool` の判断に従う |
| `.claude/settings.local.json`（local）の allow に一致 | 呼ばれない | 自動で許可 |
| SDK の `allowedTools: ["Bash(touch allowed.txt)"]` | 呼ばれない | 自動で許可 |
| どのルールにも無い | 呼ばれる | `canUseTool` の判断に従う |
| `canUseTool` が 90 秒待ってから許可 | 呼ばれる | 問題なく実行された（タイムアウトなし） |
| `permissionMode: "acceptEdits"` で `Write` | 呼ばれない | 自動で許可 |
| 読み取り専用のコマンド（`echo hi`、#12） | 呼ばれない | Claude Code が自動で許可 |

- deny は project の設定でも効いた。一方、**project の settings.json の allow は効かなかった**（完全一致・前方一致のどちらでも）。local と SDK オプションの allow は効く。
  - 原因は未確認だが、リポジトリに含まれる共有設定の allow を、未承認（未 trust）のディレクトリでは信用しない仕様と考えられる。安全側の挙動なので、cc-manabu としては問題ない。
  - user 設定（`~/.claude/settings.json`）の allow は、この環境では検証できていない。利用者の手元で確認する（#23 の結合テストに含める）。
- `canUseTool` は prompt が文字列でも使えた。**streaming input（AsyncIterable の prompt）は必須ではない**。
- `canUseTool` が数分待っても問題ない。UI で人が判断する間、Promise を返さずに待ってよい。

## canUseTool が受け取る情報（`*.can-use-tool.json` より）

```jsonc
{
  "toolName": "Bash",
  "input": { "command": "touch created.txt", "description": "Create empty file created.txt via touch" },
  "options": {
    "signal": AbortSignal,
    "suggestions": [  // 「次回から許可」に使える提案
      { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "touch created.txt" }], "behavior": "allow", "destination": "localSettings" },
      { "type": "addDirectories", "directories": ["/path/to/cwd"], "destination": "session" },
      { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
    ],
    "blockedPath": "/path/to/cwd/created.txt",
    "displayName": "Bash",
    "description": "Create empty file created.txt via touch",
    "toolUseID": "toolu_…",
    "requestId": "…"
  }
}
```

- 承認ダイアログには `displayName`、`description`、`input` を出す。`toolUseID` で、ストリーム上のツールカード（`dynamic-tool` パーツ）と結び付けられる。
- 返り値は `{ behavior: "allow", updatedInput, updatedPermissions? }` か `{ behavior: "deny", message, interrupt? }`。
  - `updatedPermissions` に `suggestions` を渡せば「常に許可」を実装できる。MVP では「今回だけ許可」と「拒否」に絞り、「常に許可」は後で検討する。
  - deny の `message` は、そのまま `is_error: true` の tool_result になり、モデルに伝わる。

## 設計への反映（#29 向け）

1. `canUseTool` に来るのは「Claude Code の自動許可・設定ルール・`permissionMode` のいずれでも決まらなかったもの」だけ。cc-manabu 側は来たものを UI に出せばよい。
2. 自前の自動許可リストは、Claude Code が自動で許可しない読み取り系だけに絞る:
   - 自動で許可する: `Read`、`Glob`、`Grep`、`WebSearch`、`TodoWrite`
   - **自動で許可しない: `WebFetch`**（URL 経由で情報を外に送れるため。Claude Code 本体も確認を求める）
3. Runner を中断したときは、`options.signal` が abort される想定。保留中の承認は deny で解決し、UI のダイアログも閉じる（abort 時の signal の挙動は #29 の実装時にテストで確認する）。
4. UI で `permissionMode` を切り替えられるようにするのも簡単（`acceptEdits` で編集系が自動許可になる）。MVP 以降の候補。
