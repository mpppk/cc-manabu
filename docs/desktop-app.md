# デスクトップアプリ版（artifact）

Claude デスクトップアプリの「Install as app」でインストールして使う cc-manabu です（実験的）。
CLI もローカルサーバも使わず、CLI 版と同じ router・サービス・リポジトリ・Web UI を、artifact のページの中でそのまま動かします。
背景と事前検証は [spikes/desktop-artifact.md](spikes/desktop-artifact.md) を参照してください。

## 仕組み

```
artifact のページ（インストールしたアプリのウィンドウ）
 ├─ Web UI（src/web）            ← CLI 版と同じ。URL の代わりにメモリ上の履歴で画面を切り替える
 ├─ oRPC の createRouterClient   ← HTTP を使わず、同じページの router を直接呼ぶ
 ├─ router・ChatRunner・承認・Wiki（src/router.ts、src/app-context.ts）← CLI 版と同じ
 ├─ Provider（src/provider）＋ process-query（src/desktop/process-query.ts）
 │     └─ desktop.childProcess.spawn($SHELL -lc 'exec claude …')  ← stream-json で直接話す
 └─ sql.js（src/desktop/database.ts）
       └─ desktop.fs で ~/.local/share/cc-manabu/desktop.sqlite に書き出す
```

CLI 版との違いは、エントリポイント（`src/desktop/main.tsx`）で差し込む次の 4 つだけです。

| 部分 | CLI 版 | デスクトップアプリ版 |
| --- | --- | --- |
| API の呼び出し | oRPC over HTTP（127.0.0.1、トークン） | `createRouterClient`（ページ内） |
| Claude Code | Agent SDK の `query()` | `process-query.ts`（SDK と同じ stream-json の制御プロトコルを自前で話す） |
| DB | bun:sqlite（WAL） | sql.js（メモリ上）を 1 秒ごとにファイルへ書き出す |
| 画面の現在地 | URL（History API） | メモリ上の履歴（`app-history.ts`）。マウスの戻る・進むと ⌘[ / ⌘] で移動 |

`process-query.ts` は、実機テスト（`bun run test:live`）で Agent SDK 版と同じテストを流して確かめています（resume・fork・承認・ストリーミング・中断・プロンプトキャッシュ・利用枠・画像・Wiki の参照資料）。

### Claude Code の見つけ方

アプリから起動したプロセスには、ログインシェルの PATH が引き継がれないことがあります。そこで `$SHELL -lc` → `$SHELL -lic` → アプリの環境の順に `command -v claude` を試し、見つかった方法でそのまま起動します（`exec "$0" "$@"` で引数をシェルに解釈させない）。見つからなければ、画面でパスを入力できます（`~/.local/share/cc-manabu/desktop-settings.json` に保存）。

### データ

- `~/.local/share/cc-manabu/desktop.sqlite` に保存します。CLI 版の `db.sqlite` とは別のファイルです（同時に開くと壊れるため）。
- 初回に CLI 版の `db.sqlite` があれば、コピーして始めるか選べます。CLI 版の DB は閉じてもチェックポイントされずに WAL にデータが残っているので、`-wal` を自前で本体に適用してから読みます（`src/desktop/wal.ts`）。

## ビルドと公開

```sh
bun run build:artifact             # dist/artifact に出力（約 18 MB、約 470 ファイル）
bun scripts/desktop-harness.ts     # Claude デスクトップアプリの外で、実機の claude を使って一通り動かす
```

`dist/artifact/index.html` がページ、それ以外（`main.js`・`styles.css`・`chunks/`）が添付ファイルです。artifact の publish は 1 回 255 ファイルまでなので、2 回に分けて同じ URL に載せます。capability は `{"desktop": {}}`、使う権限（`full-access`・`notifications`）はページの中のマニフェストに書いてあります。

フルアクセスは、自分の組織の artifact で、外部の人が書き込んでいないものにしか許可されません。ほかの人に使ってもらうときは、リンクを共有するのではなく、各自がこのリポジトリからビルドして自分のアカウントで公開してもらいます。

`scripts/desktop-harness.ts` は、`window.claude.use("desktop")` をこのマシンの fs と子プロセスにつないだ偽物に差し替え、Playwright で artifact のビルドを開きます（ホームディレクトリは一時ディレクトリ）。新しいスレッドでの質問、Bash の承認、ファイルへの保存と開き直しまでを確かめます。

## CLI 版と比べてできないこと

- **ウィンドウを閉じると生成が止まる**: 生成はページの中で動くので、閉じたり再読み込みしたりすると `claude` のプロセスも終わります（開き直しての再接続はできない）。
- **Linux**: Claude デスクトップアプリが無いので使えません。Windows はパスの扱いを確かめていません。
- **ブラウザのタブ**: 使えるのはインストールしたアプリのウィンドウだけです。
- **CLI と環境変数**: `update`・`--pwa`・`CC_MANABU_*` はありません。アップデートは artifact の再公開で、公開するたびにフルアクセスの許可を聞き直されます。
- **DB の大きさ**: DB 全体をメモリに読み、変更のたびにファイル全体を書き出します。大きな DB では遅くなります。
- **フォルダ選択**: macOS は osascript のダイアログを使えますが、artifact の外のプロセスとして開くので、ダイアログが裏に隠れることがあります。
