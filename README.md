# cc-manabu

Claude Code のログイン（Claude のサブスクリプション）を使って、ブラウザから Claude と会話するためのローカルチャットアプリです。
Bun 製の単一バイナリとして動き、起動するとローカルに Web UI を立ち上げます。

> **開発中です。** まだ動作するバージョンはありません。設計と進め方は [開発計画](docs/development-plan.md) を参照してください。

## 特徴（予定）

- 起動したディレクトリで Claude Code と同じツール（Read / Edit / Bash / WebSearch など）が使えます。副作用のあるツールは Web UI で承認してから実行します
- 会話の一覧・再開・削除、生成の停止・再生成・発言の編集ができます
- Markdown、コード、数式、Mermaid を表示できます
- モデルと effort を切り替えられ、トークン数とコストを表示します
- ブラウザを閉じても生成は続き、開き直すと途中から表示されます
- `~/.claude` の設定（CLAUDE.md、settings.json、MCP、skills）をそのまま使います

## 前提条件

- [Claude Code](https://docs.claude.com/en/docs/claude-code) がインストールされていて、`claude` コマンドでログイン済みであること

cc-manabu は自分では認証情報を持ちません。インストール済みの `claude` を [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) 経由で起動し、そのログインを使います。
利用にあたっては Anthropic の利用規約に従ってください。

## 使い方（予定）

```sh
cd your-project
cc-manabu            # ローカルサーバを起動してブラウザを開く
cc-manabu update     # 最新版に更新する
```

Web UI は `127.0.0.1` でのみ待ち受け、起動ごとに発行されるトークンがないと API を呼べません。

## 技術スタック

- ランタイム / パッケージマネージャ: [Bun](https://bun.sh)
- LLM: [Vercel AI SDK](https://ai-sdk.dev) と、自前実装の Claude Agent SDK provider
- API: [oRPC](https://orpc.unnoq.com)
- DB: SQLite（`bun:sqlite`）と Drizzle ORM
- フロントエンド: React、Tailwind CSS v4、shadcn/ui

## 開発

[開発計画](docs/development-plan.md) をもとに作業を GitHub Issue に分け、PR ベースで進めています。

## ライセンス

MIT
