# cc-manabu

インストール済みの [Claude Code](https://code.claude.com/docs/en/overview)（`claude` コマンド）を使って、ブラウザから Claude と会話するためのローカルチャットアプリです。
Bun 製の単一バイナリとして動き、起動するとローカルに Web UI を立ち上げます。

> 設計と進め方は [開発計画](docs/development-plan.md) を参照してください。

## 特徴

- 起動したディレクトリ（タスクのスレッドでは、タスクが属する環境のディレクトリ）で Claude Code と同じツール（Read / Edit / Bash / WebSearch など）が使えます。副作用のあるツールは Web UI で承認してから実行します
- 環境で、Claude Code が扱う複数のディレクトリと、回答で参照する Wiki をまとめて設定できます。タスクは 1 つの環境に属します
- 会話の一覧・再開・削除、生成の停止・再生成・発言の編集ができます
- 過去の応答から「ここから分岐」して別の質問を試せます。分岐は同じ会話の中で切り替えられ、元の会話もそのまま残ります
- 回答の一部を選ぶと、すぐ近くにメニューが出ます。「質問」でその部分を引用して分岐で追加質問でき、「ノートを作成」でタスクの Wiki のノートにできます
- 生成中に次のメッセージを予約できます。今の回答が終わってから順に送られ、停止・エラーのときは一時停止するので、内容を確かめて編集・取り消し・再開できます
- 入力欄の上に、プロンプトキャッシュの推定残り時間（目安）を表示します
- サイドバーの検索欄で、会話のタイトルと発言の本文を部分一致で探し、一致した発言へ移動できます
- ヘッダーに、サブスクリプションの利用枠（5 時間・7 日間の利用率）とリセット時刻を表示します（回答のたびに更新）
- タスクを作って、関連するスレッドをまとめられます（既存のスレッドも追加できます）。タスク画面にはリポジトリや設計資料などの関連リンクを登録できます
- タスクごとに状態（未着手・進行中・保留・完了）、進捗メモ、次にやることを記録し、タスク一覧で状態ごとに確認できます
- タスクは Markdown の Wiki を参照します。質問に関係するページは自動で参照資料として Claude に渡され、回答から引用元のページを開けます。Wiki は複数のタスクで共有できます（タスク作成時に新しく作るか既存のものを選ぶ）。サイドバーは Wiki → タスク → スレッドの順に入れ子で並び、それぞれ開閉できます
- 回答に出てきた重要な用語は、Wiki の用語ノートとして自動で作られます（タスクの設定で止められます。作成に Claude を追加で呼び出します）
- 回答中の用語にポインタを合わせる・フォーカスする・タップすると、用語ノートの説明が出て、そこからサイドパネルでノートを開けます
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
| `CC_MANABU_NO_OPEN=1` | 起動時にブラウザや PWA を開かない |
| `CC_MANABU_CHROME_PROFILE` | PWA に使う Chrome のプロファイルディレクトリ（既定: PWA をインストールしたプロファイルを探す） |
| `CC_MANABU_CHROME_APP_ID` | PWA に使う Chrome のアプリ ID（省略時は起動 URL から算出） |
| `CC_MANABU_CLAUDE_PATH` | 使う `claude` のパス（既定: PATH から探す） |
| `CC_MANABU_NO_AUTH=1` | API にアクセストークンを要求しない（デバッグ用。`--pwa` では常にトークンを要求） |
| `CC_MANABU_DB` | 会話を保存する SQLite のパス（既定: `$XDG_DATA_HOME/cc-manabu/db.sqlite`、未設定なら `~/.local/share/cc-manabu/db.sqlite`） |

### macOS の Chrome で PWA として開く

1. `CC_MANABU_PORT=4000 CC_MANABU_NO_OPEN=1 cc-manabu` で起動します。ターミナルに表示された起動 URL を、PWA を使う Chrome プロファイルで開きます。
2. Chrome のメニューで「キャスト、保存、共有」→「ページをアプリとしてインストール」を選びます。[Chrome のインストール手順](https://support.google.com/chrome/answer/9658361?hl=ja)
3. Ctrl+C でサーバーを止めます。以降は `cc-manabu` だけで、インストール済みの PWA を見つけて、インストール時のポートで起動して PWA を開きます。

   ```sh
   cc-manabu
   ```

ポートを指定しない場合は、Chrome のプロファイルからインストール済みの cc-manabu を探し、インストール時のポートを使います。複数のポートでインストールしている場合は、その旨を表示して通常のブラウザで開くので、`CC_MANABU_PORT` で使うポートを指定します。`CC_MANABU_PORT` を指定した場合は、そのポートの URL でインストールした PWA を開きます。PWA が見つからない場合、macOS の Google Chrome 以外の環境、または PWA の起動に失敗した場合は、通常のブラウザで開きます。

`--pwa` を付けると、PWA を必ず使う起動になります（`CC_MANABU_PORT` が必要です）。

```sh
CC_MANABU_PORT=4000 cc-manabu --pwa
```

PWA をインストールした Chrome プロファイルは自動で探します。複数のプロファイルにインストールした場合は、`chrome://version` に表示される「プロフィール パス」の末尾（例 `Profile 2`）を `CC_MANABU_CHROME_PROFILE` に指定します。アプリ ID は起動 URL から求めます。明示的に指定する場合は、`chrome://web-app-internals` で `http://127.0.0.1:4000/` の `app_id` を確認して `CC_MANABU_CHROME_APP_ID` に渡します。

```sh
CC_MANABU_PORT=4000 CC_MANABU_CHROME_PROFILE='Profile 2' cc-manabu --pwa
```

PWA を開くときは、起動ごとに新しいアクセストークンを渡します。Chrome や PWA が見つからない場合は、理由を表示して同じサーバーを既定のブラウザで開きます。指定したポートが使用中なら、先に使用中のプロセスを止めてください（ポートを指定せずに自動で見つけたポートが使用中なら、PWA を使わずに空いているポートで起動します）。別のポートを使う場合は、その URL で PWA をインストールし直します。`CC_MANABU_NO_OPEN=1` を指定するとサーバーだけ起動します。

## セキュリティ

- **ツールはローカルで実行されます。** Claude は起動したディレクトリと環境に追加したディレクトリで、ファイルの編集やコマンドの実行ができます。信頼できるディレクトリで起動し、信頼できるディレクトリだけを環境に追加してください
- 読み取り系のツール（Read / Glob / Grep / WebSearch / TodoWrite）は自動で許可し、それ以外は Web UI で都度承認します。`settings.json` の `deny` や `settings.local.json` の `allow` も効きます
- Web UI は `127.0.0.1` でのみ待ち受けます。API は起動ごとに発行されるトークンがないと呼べず、Host / Origin ヘッダも検証します
- トークンは起動時に表示される URL のフラグメント（`#token=...`）で渡されます。この URL を共有しないでください
- `CC_MANABU_NO_AUTH=1` を付けて起動すると、トークンなしで API を呼べます（`bun run dev` の再起動でトークンが変わり、開いているページが使えなくなるのを避けるためのデバッグ用）。Host / Origin の検証は残りますが、同じマシンの他のプロセスやユーザーからも Claude にファイル編集やコマンド実行をさせられるので、普段は使わないでください
- 会話の内容（添付した画像を含む）は上記の SQLite ファイルにローカル保存されます。Claude Code 側のセッションの記録は `~/.claude` に残ります

## 開発

```sh
bun install
bun run dev          # 開発サーバ（HMR）
CC_MANABU_NO_AUTH=1 CC_MANABU_PORT=4000 bun run dev
                     # トークンなしの開発サーバ（再起動しても同じ URL で開き直せる）
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
