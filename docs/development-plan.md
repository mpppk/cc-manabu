# monet（旧 cc-manabu）開発計画

Claude のサブスクリプション（各利用者の Claude Code ログイン）を使い、ローカルの Web UI で Claude と会話するアプリです。
Bun 製の CLI ツールとして TypeScript で実装し、単一バイナリで配布します。

## 1. 決定事項（ヒアリング結果）

| 項目 | 決定 |
| --- | --- |
| 目的 | 汎用チャットクライアント |
| UI 形態 | CLI＋ローカル Web UI（`mpppk/skills` の `bun-cli-webui` 構成）。引数なしで起動するとサーバを立ててブラウザを開く |
| 利用者 | OSS として公開。各利用者が自分の Claude Code ログインで使う |
| ツール | Claude Code の組み込みツール（Bash/Edit 含む）を許可する |
| 統合方式 | Agent SDK の `query()` を包む最小限の AI SDK `LanguageModel` を自前実装する。community provider は使わない |
| 履歴管理 | Agent SDK のセッション resume。2 回目以降は `sessionId` を resume し、最新のユーザー発話だけを送る |
| 永続化 | SQLite＋Drizzle（XDG パス） |
| cwd | スレッドを作ったときの作業ディレクトリ（タスクのスレッドは環境の先頭のディレクトリ、それ以外は起動時のカレントディレクトリ）。環境の残りのディレクトリは additionalDirectories で渡す |
| 承認フロー | `canUseTool` でサーバを待機させ、Web UI で Allow/Deny する。読み取り系のツールは自動で許可する |
| 設定の読み込み | `settingSources: ["user", "project", "local"]`（CLAUDE.md・settings.json・MCP・skills が効く） |
| システムプロンプト | `claude_code` preset に、チャット向けの指示を append する |
| UI で選べる設定 | モデル切替、effort/thinking（thinking は reasoning として表示）、コスト・使用量の表示 |
| MVP の UI 機能 | 会話一覧・再開・削除、中断・再生成・編集 |
| レンダリング | Markdown（GFM）、コードハイライト、数式（KaTeX）、Mermaid |
| CLI 機能 | 自己アップデート（`update`）。ほかは `--help` と `--version` のみ |
| アクセス制御 | 127.0.0.1 にのみ bind し、起動ごとにランダムなトークンを発行する。Origin/Host を検証する |
| Claude Code 本体 | 利用者がインストールした `claude` を `pathToClaudeCodeExecutable` に渡す |
| エラー処理 | `typescript` skill に従う。内部は `@praha/byethrow` の Result 型、AI SDK と oRPC との境界でそれぞれの形式に変換する |
| テスト | Provider の単体テスト（fixture）、DB・oRPC のテスト、Web UI の E2E（モック Provider）、実機の結合テスト（ローカルで手動実行） |
| 通信 | oRPC に統一する。チャットのストリームは `eventIterator` で流し、`useChat` にはカスタム `ChatTransport` を渡す |
| 生成中の振る舞い | リロードしても生成を続ける（再接続で途中から表示）、複数会話の同時生成、承認待ちの通知 |
| 配布 | `bun build --compile` の単一バイナリ（linux-x64/arm64、darwin-arm64、windows-x64）を GitHub Releases で配布。`release.yml`＋`cd.yml`＋CI |
| 開発運用 | 計画を GitHub Issue に分割し、`issue-claim-protocol` で並行実装する |
| ライセンス / 言語 | MIT、UI は日本語のみ |

## 2. アーキテクチャ

```
Browser (React + useChat)
   │  oRPC over HTTP (Authorization: Bearer <起動時トークン>)
   │   ├─ chats.*      : 会話の CRUD
   │   ├─ chat.send    : eventIterator<UIMessageChunk>
   │   ├─ chat.reconnect / chat.stop
   │   └─ approvals.respond
   ▼
Bun.serve (127.0.0.1)
   ├─ ChatRunner (会話ごと / バックグラウンドで生成を継続し、チャンクをバッファ)
   │     └─ streamText({ model: claudeCode(...) }) → toUIMessageStream()
   │            └─ ClaudeCodeLanguageModel (自前 Provider)
   │                   └─ @anthropic-ai/claude-agent-sdk query()
   │                          └─ 利用者の `claude` (サブスクのログイン)
   ├─ ApprovalBroker (canUseTool の待機と、UI からの回答の受け渡し)
   └─ SQLite (Drizzle)
```

### 2.1 ディレクトリ構成（案）

```
src/
  binary.ts            # 引数あり → CLI、なし → サーバ起動＋ブラウザ
  cli.ts               # --help / --version / update
  update.ts            # GitHub Releases からの自己アップデート
  server.ts            # Bun.serve, トークン/Origin 検証, SPA 配信
  router.ts            # oRPC ルータ
  runtime-config.ts
  provider/            # 自前 AI SDK Provider（外部依存は ai-sdk/provider と agent-sdk のみ）
    claude-code-language-model.ts
    convert-prompt.ts        # AI SDK prompt → 最新 user 発話＋resume 情報
    map-stream.ts            # SDKMessage → LanguageModel stream part
    map-finish-reason.ts
    errors.ts                # error-factory によるカスタムエラー
    query-fn.ts              # query() を差し替え可能にする DI ポイント
  chat/
    runner.ts                # ChatRunner: 生成のライフサイクル、バッファ、再接続
    runner-registry.ts       # 同時生成の管理と上限
    approval-broker.ts
    persistence.ts           # 生成完了時の UIMessage 保存
    title.ts                 # 会話タイトルの自動生成
  claude/
    detect.ts                # claude の検出、バージョン確認、未ログインの検出
  db/
    index.ts  path.ts  schema.ts  migrate.ts  migrations/*.sql
  web/
    index.html  frontend.tsx
    transport.ts             # oRPC を使う ChatTransport (sendMessages / reconnectToStream)
    components/ ...          # shadcn/ui
test/
  fixtures/sdk-messages/*.jsonl  # 実機から記録した SDKMessage 列
build-binary.ts  build.ts  bunfig.toml  biome.json
```

### 2.2 自前 Provider の設計

AI SDK 7 / `LanguageModelV4` を実装します（[spike](spikes/ai-sdk-spec.md)、[SDKMessage の観察](spikes/sdk-messages.md)）。

- **入力の変換**: AI SDK の `prompt` は全履歴を含みますが、送るのは末尾の user メッセージだけです。resume 先の `sessionId` などは `providerOptions["claude-code"]` で受け取ります。
  - `sessionId` がなければ新規セッション、あれば `resume`。
  - 再生成・編集は `resume`＋`resumeSessionAt: <分岐点の SDK message uuid>`＋`forkSession: true`。
- **出力の変換**（`includePartialMessages: true`）:
  - `stream_event` の text/thinking delta → `text-*` / `reasoning-*`
  - `assistant` の `tool_use` → `tool-call`（`providerExecuted: true, dynamic: true`。UI では `dynamic-tool` パーツになる）
  - `user` の `tool_result` → `tool-result`（エラー時は `isError`）
  - `result` → `finish`。usage、finishReason、`providerMetadata["claude-code"]`（`sessionId`、`costUsd`、`durationMs`、各メッセージの uuid）。UIMessage の metadata へは `toUIMessageStream` の `messageMetadata` で `finish-step` から移す
  - `system/init` → `sessionId` を早めに通知する（中断時にも resume できるようにするため）
- **非対応の設定**（temperature、topP、maxOutputTokens、stopSequences、AI SDK のユーザー定義 tools など）は `unsupported` の warning を返すだけにします。
- **中断**: `abortSignal` を `AbortController` に橋渡しします。
- **認証エラー**: `authentication_failed` などを検出し、`claude` へのログインを案内するエラーに変換します。
- `doGenerate` は `doStream` を集約して実装します（タイトル生成で使う）。
- 構造化出力・画像入力・MCP ブリッジは MVP の対象外です。

### 2.3 ChatRunner（バックグラウンド生成と再接続）

- `chat.send` で Runner を開始します。`streamText(...).toUIMessageStream()` のチャンクを Runner 内のバッファに積み、購読中のクライアントへ配信します。
- クライアントが切断しても生成は止めません（`consumeStream` 相当）。止めるのは `chat.stop` が呼ばれたときだけです。
- `chat.reconnect` は進行中の Runner があればバッファを先頭から再送し、その後のチャンクを流します。Runner がなければ何も流さずに終わります。transport の `reconnectToStream` にこれを割り当てます。
- 完了時（成功・中断・エラーのいずれも）に UIMessage を DB に保存し、`sessionId` と SDK の uuid を更新します。
- 同時に生成できる数の上限は設定で持ちます（既定値は 10。生成中でも「現在地を維持して送信」で次々と質問できるように多めにしている）。

### 2.4 承認フロー

1. `canUseTool(toolName, input)` が呼ばれたら、読み取り系の allowlist（Read、Glob、Grep、WebSearch、WebFetch など）に入っているか判定します。入っていれば即許可します。
2. 入っていなければ `ApprovalBroker` に pending を登録し、UI ストリームに `data-approval` パーツを流します。
3. UI は承認ダイアログを表示します。タブタイトルと Notification API でも通知します。
4. `approvals.respond({ id, behavior, updatedInput?, message? })` で Promise を解決します。
5. 中断や切断の扱い: Runner の中断時は pending をすべて deny で解決します。切断されただけなら待機を続けます（リロード後に再表示する）。

settings.json の allow/deny ルールは Claude Code 側で先に評価されるので、`canUseTool` に来るのは未決定のものだけ、という前提です（Phase 0 で検証）。

### 2.5 DB スキーマ（案）

- `chats`: id, title, session_id, model, effort, cwd, status (`idle` / `running` / `awaiting_approval` / `error`), created_at, updated_at
- `messages`: id (UIMessage id), chat_id, role, parts (JSON), metadata (JSON: usage, costUsd, durationMs, model), sdk_uuid (分岐点の指定に使う), seq, created_at

MVP の編集は**線形履歴**とします。編集した地点より後ろのメッセージを削除し、fork 後のセッション ID に置き換えます。分岐ツリーの UI は作りません。

### 2.6 セキュリティ

- `127.0.0.1` にのみ bind します。起動ごとに 256bit のトークンを生成し、`http://127.0.0.1:<port>/#token=...` を開きます。トークンは URL fragment から `sessionStorage` に移し、URL からは消します。
- すべての oRPC リクエストでトークン、`Host` ヘッダ（DNS rebinding 対策）、`Origin` ヘッダ（CSRF 対策）を検証します。
- SPA の静的配信だけはトークンなしで許可します（API は叩けない）。

## 3. フェーズと Issue 分割

各フェーズの項目は、そのまま 1 Issue の単位を想定しています。依存関係は「←」で示します。

### Phase 0: 技術検証（スパイク）

この結果で以降の設計を確定します。結果は `docs/spikes/` に記録します。

- 0-1. Agent SDK を `bun build --compile` のバイナリから動かす。`pathToClaudeCodeExecutable` に利用者の `claude` を渡す構成で、各 OS で起動できるか確認する。
- 0-2. 実機の SDKMessage 列を JSONL で記録するスクリプトを作る（テキストのみ、thinking、ツール使用、承認、中断、エラー、resume、fork）。これを単体テストの fixture にする。
- 0-3. `resume`、`resumeSessionAt`、`forkSession` の挙動を確認する。再生成・編集で期待どおりに分岐するか。
- 0-4. `canUseTool` と settings.json の allow/deny の評価順。長時間待機しても問題ないか。
- 0-5. AI SDK の対象バージョンと `LanguageModel` spec を確定する。`providerExecuted` なツールが UIMessage にどう載るか確認する。
- 0-6. モデル一覧・アカウント情報・ログイン状態を SDK から取得する方法（`supportedModels()`、`accountInfo()` などがあるか）。
- 0-7. Streamdown など、ストリーミング対応の Markdown レンダラで数式と Mermaid が描けるか確認する。

### Phase 1: プロジェクト基盤

- 1-1. `bun init`、tsconfig、Biome、`package.json`（`bin`、scripts）、MIT LICENSE、README の骨子
- 1-2. CI（lint、typecheck、`bun test`）
- 1-3. `@praha/error-factory` と `@praha/byethrow` の導入、共通エラー定義、AI SDK・oRPC 境界での変換ユーティリティ
- 1-4. `binary.ts`、`cli.ts`（`--help`、`--version`）、`runtime-config.ts`

### Phase 2: 自前 Provider ← 0-2, 0-5, 1-3

- 2-1. Provider の骨格（`provider` ファクトリ、モデル ID、settings、DI 可能な `query`）
- 2-2. プロンプト変換（末尾の user 発話の抽出、resume・fork オプション）
- 2-3. `doStream` のストリーム変換（text、reasoning、tool-call、tool-result、finish、usage、providerMetadata）
- 2-4. finish reason、エラー（認証・アカウント状態・中断）の変換
- 2-5. `doGenerate`
- 2-6. fixture を使った単体テスト
- 2-7. 実機の結合テスト（`bun test:live`、ローカル専用）

### Phase 3: サーバ ← 2

- 3-1. DB（schema、migration、XDG パス、`CC_MANABU_DB` で上書き）
- 3-2. `server.ts`（トークン、Host/Origin 検証、ポートの空き確認、ブラウザ起動）
- 3-3. oRPC ルータ: `chats.list` / `get` / `create` / `delete` / `rename`
- 3-4. ChatRunner とレジストリ（バックグラウンド生成、バッファ、再接続、同時実行の上限）
- 3-5. `chat.send` / `chat.reconnect` / `chat.stop` と、完了時の永続化
- 3-6. ApprovalBroker と `approvals.respond`
- 3-7. 再生成と編集（fork とメッセージの切り詰め）
- 3-8. タイトルの自動生成
- 3-9. `claude` の検出と未ログインの案内（起動時と、エラー発生時）
- 3-10. DB・oRPC のテスト（インメモリ SQLite＋モック Provider）

### Phase 4: Web UI ← 3

- 4-1. React、Tailwind v4、shadcn/ui の基盤とレイアウト（サイドバーとチャット画面）
- 4-2. oRPC の `ChatTransport`（`sendMessages` / `reconnectToStream`）と `useChat` の結線
- 4-3. 会話一覧・新規作成・削除・名前変更、生成中と承認待ちのバッジ
- 4-4. メッセージ描画（Markdown、コード、KaTeX、Mermaid、reasoning の折り畳み）
- 4-5. ツール実行カード（入力、出力、エラー、Bash 出力と diff の簡易表示）
- 4-6. 承認ダイアログと通知（タブタイトル、Notification API）
- 4-7. モデルと effort の選択、使用量・コストの表示
- 4-8. 停止・再生成・編集の UI
- 4-9. E2E テスト（Playwright＋モック Provider）

### Phase 5: 配布 ← 1, 4

- 5-1. `build.ts` と `build-binary.ts`（クロスコンパイル）
- 5-2. `cd.yml`（品質チェック → ビルドマトリクス → Release と `checksums.txt`）、`release.yml`
- 5-3. `update` コマンド
- 5-4. README（前提条件として `claude` のインストールとログインが必要なこと、セキュリティ上の注意、利用規約に関する注意）

### MVP 以降の候補

画像・ファイル添付（streaming input）、CLI でのワンショット質問と会話管理、分岐ツリーの UI、AI SDK ツールの in-process MCP ブリッジ、LAN 公開、i18n、会話ごとの cwd 指定。

## 4. リスクと未決事項

### リスク

- **利用規約**: Anthropic は、事前承認なしに第三者が自社製品で claude.ai ログインやサブスクの利用枠を提供することを認めていません。monet は各利用者がインストールした `claude` のログインを使う形ですが、OSS 公開の前に規約上問題がないか確認が必要です。README での明記や、`ANTHROPIC_API_KEY` での利用を案内する選択肢も検討します。
- **Agent SDK の変化が速い**: メッセージの形やオプションが頻繁に変わります。SDK のバージョンは固定し、fixture テストで差分を検出します。
- **単一バイナリと Agent SDK の相性**: Phase 0-1 で検証します。うまくいかなければ npm（bunx）配布に切り替えます。
- **Bash などを実行できる Web UI**: トークン、Origin/Host 検証、承認フローの不備は即座にローカル環境の侵害につながります。セキュリティテストを Phase 3 の完了条件に含めます。

### 未決事項（実装中に決める）

- 同時生成数の既定上限と、既定ポート
- タイトル生成に使うモデル（haiku でサブスク枠を少し消費するか、最初の発話の先頭を切り出すだけにするか）
- 読み取り系として自動許可するツールの正確な一覧
- 編集時の分岐（MVP は線形で切り詰める。分岐を保持するかは後で判断）
