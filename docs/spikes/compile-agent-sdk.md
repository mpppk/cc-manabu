# Spike: bun compile のバイナリから Agent SDK を動かす（#11）

`scripts/spikes/compile-agent-sdk.ts` を `bun build --compile` して、linux-x64 で実行した結果です（Bun 1.4.4、Agent SDK 0.3.330）。

## 結果

| 確認項目 | 結果 |
| --- | --- |
| `pathToClaudeCodeExecutable` に利用者の `claude`（`/opt/node22/bin/claude`、npm 版）を渡して実行 | **動いた**（init → result: success、約 3.6 秒） |
| `pathToClaudeCodeExecutable` を指定せずに実行 | `Native CLI binary for linux-x64 not found. … set options.pathToClaudeCodeExecutable.` で失敗 |
| バイナリサイズ（linux-x64） | 110.5 MB（Bun 単体の hello world が 109.1 MB なので、SDK 分は約 1.4 MB） |
| クロスコンパイル | `bun-darwin-arm64`（90.6 MB）、`bun-windows-x64`（116.7 MB）、`bun-linux-arm64`（110.6 MB）とも成功 |

## 分かったこと

- Agent SDK の JS 部分は小さく、単一バイナリに問題なく入る。
- SDK は既定で、プラットフォーム別の optional dependency（`@anthropic-ai/claude-agent-sdk-linux-x64` など、**約 364 MB** の Claude Code ネイティブバイナリ）を探しにいく。単一バイナリにはこれが入らないので、**`pathToClaudeCodeExecutable` の指定が必須**。
  - 開発時の `bun install` では、この optional dependency が入る（ディスクを 364 MB 使う）。
  - 同梱すると配布サイズが数百 MB になり、プラットフォーム別の管理も要る。計画どおり、利用者がインストールした `claude` を使う方針で進める。
- 利用者の `claude` は、ネイティブインストーラ版でも npm 版でも、実行ファイルのパスを渡せば動く（npm 版で確認）。

## 設計への反映

- `claude` の探索（#32）: `CC_MANABU_CLAUDE_PATH` → PATH 上の `claude` の順に探す。見つからなければ起動時にエラーで案内する。SDK の既定パスには頼らない。
- `build-binary.ts`（#43）: 特別な設定は不要。`Bun.build({ compile })` でそのまま入る。
- darwin / windows での実行確認は、リリースワークフロー（#44）の成果物を手元で動かして行う。
  - Windows では `claude` の実体（`claude.exe` / `claude.cmd`）のパス解決に注意する（`Bun.which` の結果をそのまま渡せるか確認する）。
