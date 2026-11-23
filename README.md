# cc-manabu

インストール済みの [Claude Code](https://code.claude.com/docs/en/overview)（`claude` コマンド）を使って、ブラウザから Claude と会話するためのローカルチャットアプリです。
Bun 製の単一バイナリとして動き、起動するとローカルに Web UI を立ち上げます。

> 設計と進め方は [開発計画](docs/development-plan.md) を参照してください。

## 特徴

- 起動したディレクトリで Claude Code と同じツール（Read / Edit / Bash / WebSearch など）が使えます。副作用のあるツールは Web UI で承認してから実行します
- 会話の一覧・再開・削除、生成の停止・再生成・発言の編集ができます
- 過去の応答から「ここから分岐」して別の質問を試せます。分岐は同じ会話の中で切り替えられ、元の会話もそのまま残ります
- 回答の一部を選んで「選択範囲について質問」すると、その部分を引用して分岐で追加質問できます
- プロジェクトを作って、関連するスレッドをまとめられます（既存のスレッドも追加できます）。プロジェクト画面にはリポジトリや設計資料などの関連リンクを登録できます
- プロジェクトごとに状態（未着手・進行中・保留・完了）、進捗メモ、次にやることを記録し、プロジェクト一覧で状態ごとに確認できます
- プロジェクトごとに Markdown の Wiki を持てます。質問に関係するページは自動で参照資料として Claude に渡され、回答から引用元のページを開けます
- 回答に出てきた重要な用語は、Wiki の用語ページとして自動で作られます（プロジェクトの設定で止められます。作成に Claude を追加で呼び出します）
- 回答中の用語にポインタを合わせる・フォーカスする・タップすると、用語ページの説明が出て、そこから Wiki を開けます
- スクリーンショットなどの画像を貼り付け（またはファイル選択・ドロップ）して質問できます
- Markdown、コード、数式（KaTeX）、Mermaid を表示できます
- モデルと effort を切り替えられ、トークン数とコストを表示します
- ブラウザを閉じても生成は続き、開き直すと途中から表示されます。承認待ちはタブのタイトルと通知で知らせます
- `~/.claude` とプロジェクトの設定（CLAUDE.md、settings.json、MCP、skills）をそのまま使います

## 前提条件

- [Claude Code](https://code.claude.com/docs/en/setup) がインストールされていて、`claude` コマンドが動くこと
- `claude` の認証が済んでいること（下の「認証と利用規約」を参照）

cc-manabu は自分では認証情報を扱いません。PATH 上の `claude`（または `CC_MANABU_CLAUDE_PATH` で指定したもの）を [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 経由で起動し、その認証で Claude を呼び出します。

## 認証と利用規約

cc-manabu は、利用者が自分の PC で起動し、自分だけが使うローカルツールです。

- Web サービスとして公開したり、他の人に Claude を使わせたりするものではありません（サーバは `127.0.0.1` でのみ待ち受けます）
- 認証情報を収集・保存・中継しません。ログインは Anthropic 純正の `claude` で利用者自身が行い、cc-manabu は改変していない `claude` をそのまま起動します
- 利用枠は、その利用者自身の Claude のプラン（または API キー）のものが使われます

Anthropic は、サードパーティの製品が claude.ai のログインを提供したり、利用者に代わってサブスクリプションの認証情報でリクエストを中継したりすることを認めていません（[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)、[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)）。また、Pro / Max などの利用枠は、Claude Code と Agent SDK の通常の個人利用を前提としています。cc-manabu を複数人で共有するサーバとして動かしたり、他の人の利用を肩代わりしたりしないでください。

規約は変わることがあります。上のページと [Usage Policy](https://www.anthropic.com/legal/aup)、[Consumer Terms](https://www.anthropic.com/legal/consumer-terms)、[Commercial Terms](https://www.anthropic.com/legal/commercial-terms) の最新版を確認し、自分の使い方が規約に沿っているかを確認してください。

API キーで使う場合は、[Claude Console](https://platform.claude.com/) で発行したキーを環境変数に設定してから起動します。cc-manabu は環境変数をそのまま `claude` に渡します。

```sh
export ANTHROPIC_API_KEY=sk-ant-...
cc-manabu
```

ヘッダには `claude` が報告するアカウントの種類（例: Claude API）が表示されるので、どの認証で動いているかを確認できます。

## インストール

[GitHub Releases](https://github.com/mpppk/cc-manabu/releases) から、使っている OS 向けのアーカイブ（linux-x64 / linux-arm64 / darwin-arm64 / windows-x64）をダウンロードして展開し、PATH の通ったディレクトリに置きます。

```sh
# 例: Linux (x64)
curl -LO https://github.com/mpppk/cc-manabu/releases/latest/download/cc-manabu-linux-x64.tar.gz
tar xzf cc-manabu-linux-x64.tar.gz
install cc-manabu ~/.local/bin/
```

`checksums.txt` に各アーカイブの SHA-256 があります。macOS で「開発元を確認できない」と表示される場合は `xattr -d com.apple.quarantine cc-manabu` で隔離属性を外してください。

## 使い方

```sh
cd your-project
cc-manabu            # ローカルサーバを起動してブラウザを開く
cc-manabu update     # GitHub Releases の最新版に更新する（SHA-256 を検証してから置き換える）
cc-manabu --help
```

| 環境変数 | 説明 |
| --- | --- |
| `CC_MANABU_PORT` | 待ち受けるポート（既定: 空いているポート） |
| `CC_MANABU_NO_OPEN=1` | 起動時にブラウザを開かない |
| `CC_MANABU_CLAUDE_PATH` | 使う `claude` のパス（既定: PATH から探す） |
| `CC_MANABU_DB` | 会話を保存する SQLite のパス（既定: `$XDG_DATA_HOME/cc-manabu/db.sqlite`、未設定なら `~/.local/share/cc-manabu/db.sqlite`） |

## セキュリティ

- **ツールはローカルで実行されます。** Claude は起動したディレクトリで、ファイルの編集やコマンドの実行ができます。信頼できるディレクトリで起動してください
- 読み取り系のツール（Read / Glob / Grep / WebSearch / TodoWrite）は自動で許可し、それ以外は Web UI で都度承認します。`settings.json` の `deny` や `settings.local.json` の `allow` も効きます
- Web UI は `127.0.0.1` でのみ待ち受けます。API は起動ごとに発行されるトークンがないと呼べず、Host / Origin ヘッダも検証します
- トークンは起動時に表示される URL のフラグメント（`#token=...`）で渡されます。この URL を共有しないでください
- 会話の内容（添付した画像を含む）は上記の SQLite ファイルにローカル保存されます。Claude Code 側のセッションの記録は `~/.claude` に残ります

## 開発

```sh
bun install
bun run dev          # 開発サーバ（HMR）
bun run check        # Biome
bun run typecheck
bun test             # 単体テスト
bun run test:e2e     # Playwright の E2E（モックの Claude）
bun run build:binary # 単一バイナリをビルド
```

テストの種類と実機での確認手順は [docs/testing.md](docs/testing.md) を参照してください。作業は GitHub Issue に分け、PR ベースで進めています。

## 技術スタック

- ランタイム / パッケージマネージャ: [Bun](https://bun.sh)
- LLM: [Vercel AI SDK](https://ai-sdk.dev) と、自前実装の Claude Agent SDK provider（`src/provider/`）
- API: [oRPC](https://orpc.unnoq.com)
- DB: SQLite（`bun:sqlite`）と Drizzle ORM
- フロントエンド: React、Tailwind CSS v4、shadcn/ui、Streamdown

## ライセンス

MIT
