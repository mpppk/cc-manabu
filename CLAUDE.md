# monet

Claude Code のログイン（サブスクリプション）を使うローカルチャットアプリ。設計は [docs/development-plan.md](docs/development-plan.md) を参照。

@AGENTS.md

## 開発コマンド

- ランタイム / パッケージマネージャは **Bun** のみを使う（npm / yarn / pnpm / node は使わない）
- `bun install` / `bun add <pkg>` / `bun add -d <pkg>`
- `bun run check`: Biome（lint＋format チェック）。`bun run format` で整形
- `bun run typecheck`: `tsc --noEmit`
- `bun test`: 単体テスト
- `bun run test:e2e`: Playwright の E2E テスト（モックの Claude で Web UI を動かす。初回は `bunx playwright install chromium`）
- `bun run test:live`: 実機の `claude` を使う結合テスト（CI では実行しない。詳細は [docs/testing.md](docs/testing.md)）
- `bun run record:fixtures`: Provider のテスト用 fixture を実機で記録し直す

PR を出す前に `bun run check && bun run typecheck && bun test` を通す。

## 実装ルール

- [mpppk/skills](https://github.com/mpppk/skills) の skill に従う
  - `bun-cli-webui`: プロジェクト構成（binary.ts / cli.ts / server.ts / router.ts、oRPC、SQLite＋Drizzle、React＋Tailwind v4＋shadcn/ui、build）
  - `typescript`: エラーは `@praha/error-factory` のカスタムエラーで表現し、失敗しうる関数は throw せず `@praha/byethrow` の Result を返す
- Result は内部で使い、外部インターフェースとの境界で変換する
  - AI SDK の `LanguageModel`（`doStream` / `doGenerate`）: 例外、または stream の `error` パート
  - oRPC ハンドラ: `ORPCError`
  - CLI: `handleCliError`
- community provider（`ai-sdk-provider-claude-code` など）には依存しない。Agent SDK との接続は `src/provider/` に自前で実装する
- UI の文言は日本語（例外は AGENTS.md の用語集を参照）
- 用語は AGENTS.md の用語集に従う
- import はファイル拡張子付きで書く（`./foo.ts`）

## 複数セッションでの Issue 並行処理

`issue-claim-protocol` skill（mpppk/skills）に従う。リポジトリ固有設定:

- CLAIM_LABEL: `in-progress`
- CLAIM_BRANCH_PREFIX: `claude/issue-<N>-<slug>`
- CLAIM_RESOURCES:
  - `db-migration`: `src/db/migrations/**`, `src/db/schema.ts`
  - `lockfile`: `bun.lock`
  - `ci-config`: `.github/workflows/**`

Issue はフェーズごとの親 Issue（`epic` ラベル）の sub-issue になっている。claim は子 Issue 単位で取り、親 Issue は claim しない。
