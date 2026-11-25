/**
 * デスクトップアプリ版（artifact）のエントリポイント。
 *
 * Claude デスクトップアプリで「Install as app」したウィンドウの中で、CLI 版のサーバ（router・
 * サービス・リポジトリ）と Web UI をそのまま動かす。違うのは次の 4 点だけ:
 * - API はプロセス内のクライアント（oRPC の createRouterClient）で呼ぶ
 * - Claude Code は desktop.childProcess で起動し、stream-json で直接話す（process-query.ts）
 * - DB は sql.js でメモリ上に開き、desktop.fs でファイルに書き出す（database.ts）
 * - 画面の現在地は URL ではなくメモリ上の履歴で持つ
 */
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../web/app.tsx";
import { Button } from "../web/components/ui/button.tsx";
import { createMemoryHistory, setAppHistory } from "../web/lib/app-history.ts";
import { approvalMessage, setApprovalNotifier } from "../web/lib/notify.ts";
import type { ApiClient } from "../web/lib/orpc.ts";
import {
  createDesktopApi,
  type DesktopPaths,
  inspectStorage,
  type OpenedStorage,
  openStorage,
  readSettings,
  resolveDesktopPaths,
  writeSettings,
} from "./boot.ts";
import { type ClaudeLaunch, detectClaude } from "./claude-launch.ts";
import {
  type DesktopApi,
  type FullDesktopApi,
  hasFullAccessApi,
  loadDesktopApi,
} from "./desktop-api.ts";

type Phase =
  | { kind: "loading"; message: string }
  | { kind: "outside" }
  | { kind: "install"; state: "available" | "installed" | "unavailable" }
  | {
      kind: "permission";
      state: "prompt" | "denied" | "unavailable";
    }
  | { kind: "claude-missing"; message: string; tried: string[] }
  | { kind: "import"; cliDatabase: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; api: ApiClient };

type Session = {
  desktop: FullDesktopApi;
  platform: string;
  paths: DesktopPaths;
};

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** アプリのアイコン（Dock・タスクバー）。 */
const drawIcon = (): string => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const g = canvas.getContext("2d");
  if (g === null) return "";
  g.fillStyle = "#18181b";
  g.beginPath();
  g.roundRect(8, 8, 240, 240, 56);
  g.fill();
  g.fillStyle = "#fafafa";
  g.font =
    "700 148px 'Hiragino Sans', 'Yu Gothic UI', 'Noto Sans JP', sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("学", 128, 134);
  g.fillStyle = "#f59e0b";
  g.fillRect(72, 204, 112, 10);
  return canvas.toDataURL("image/png");
};

/** 承認待ちの件数を Dock のバッジに出す（App が document.title に出す件数を読む）。 */
const mirrorTitleToBadge = (desktop: DesktopApi) => {
  let last = "";
  const update = () => {
    const count = /^\((\d+)\)/.exec(document.title)?.[1] ?? "";
    if (count === last) return;
    last = count;
    desktop.app.dock.setBadge(count).catch(() => {});
  };
  new MutationObserver(update).observe(document.head, {
    subtree: true,
    childList: true,
    characterData: true,
  });
};

/** マウスの戻る・進むボタンと ⌘[ / ⌘] で、メモリ上の履歴を移動する。 */
const installHistory = () => {
  const history = createMemoryHistory("/");
  setAppHistory(history);
  window.addEventListener("mouseup", (event) => {
    if (event.button === 3) history.back();
    if (event.button === 4) history.forward();
  });
  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    if (event.key === "[") history.back();
    if (event.key === "]") history.forward();
  });
};

const Screen = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <main className="flex h-full min-h-screen items-center justify-center bg-background p-6 text-foreground">
    <div className="flex w-full max-w-lg flex-col gap-4">
      <h1 className="font-bold text-2xl">{title}</h1>
      {children}
    </div>
  </main>
);

const Gate = () => {
  const [phase, setPhase] = useState<Phase>({
    kind: "loading",
    message: "起動しています…",
  });
  const [session, setSession] = useState<Session>();
  const [desktopApi, setDesktopApi] = useState<DesktopApi | null>(null);
  const [claudePath, setClaudePath] = useState("");
  const [saveError, setSaveError] = useState<string>();

  /** 権限が取れてから、claude を探して DB を開き、App を出す。 */
  const start = useCallback(
    async (
      current: Session,
      storageChoice?: "desktop" | "cli" | "new",
      override?: string,
    ) => {
      const { desktop, platform, paths } = current;
      try {
        setPhase({ kind: "loading", message: "Claude Code を探しています…" });
        const settings = await readSettings(desktop, paths);
        const detected = await detectClaude(desktop, {
          platform,
          override: override ?? settings.claudePath,
        });
        if (!detected.found) {
          setPhase({
            kind: "claude-missing",
            message: detected.message,
            tried: detected.tried,
          });
          return;
        }
        const launch: ClaudeLaunch = detected.launch;
        if (override !== undefined) {
          await writeSettings(desktop, paths, {
            ...settings,
            claudePath: override,
          });
        }
        let source = storageChoice;
        if (source === undefined) {
          const storage = await inspectStorage(desktop, paths);
          if (storage.kind === "importable") {
            setPhase({ kind: "import", cliDatabase: storage.cliDatabase });
            return;
          }
          source = storage.kind === "existing" ? "desktop" : "new";
        }
        setPhase({ kind: "loading", message: "データを開いています…" });
        const storage: OpenedStorage = await openStorage(
          desktop,
          paths,
          source,
          (error) => setSaveError(errorText(error)),
        );
        const flush = () => void storage.persister.flush();
        window.addEventListener("pagehide", flush);
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "hidden") flush();
        });
        const api = await createDesktopApi({
          desktop,
          platform,
          paths,
          launch,
          storage,
        });
        installHistory();
        setApprovalNotifier({
          requestPermission: () => {},
          notify: (chatTitle) => {
            if (document.hasFocus()) return;
            desktop.notification
              ?.show({ body: approvalMessage(chatTitle) })
              .catch(() => {});
          },
        });
        mirrorTitleToBadge(desktop);
        setPhase({ kind: "ready", api });
      } catch (error) {
        setPhase({ kind: "error", message: errorText(error) });
      }
    },
    [],
  );

  /** 実行環境と権限を確かめる。 */
  const boot = useCallback(async () => {
    const desktop = await loadDesktopApi();
    setDesktopApi(desktop);
    if (desktop === null) {
      setPhase({ kind: "outside" });
      return;
    }
    if (!hasFullAccessApi(desktop)) {
      const state = await desktop.install.state().catch(() => "unavailable");
      setPhase({
        kind: "install",
        state: state as "available" | "installed" | "unavailable",
      });
      return;
    }
    desktop.app.dock.setIcon(drawIcon()).catch(() => {});
    const permissions = await desktop.permissions.state().catch(() => null);
    const full = permissions?.["full-access"] ?? "unavailable";
    if (full !== "granted") {
      setPhase({ kind: "permission", state: full });
      return;
    }
    const platform = await desktop.os.platform();
    const home = await desktop.os.homedir();
    const current = {
      desktop,
      platform,
      paths: resolveDesktopPaths(home, platform),
    };
    setSession(current);
    await start(current);
  }, [start]);

  useEffect(() => {
    boot().catch((error) =>
      setPhase({ kind: "error", message: errorText(error) }),
    );
  }, [boot]);

  switch (phase.kind) {
    case "ready":
      return (
        <>
          {saveError !== undefined && (
            <div
              role="alert"
              className="fixed inset-x-0 top-0 z-50 bg-destructive px-4 py-2 text-center text-sm text-white"
            >
              データを保存できませんでした: {saveError}
            </div>
          )}
          <App api={phase.api} />
        </>
      );
    case "loading":
      return (
        <Screen title="cc-manabu">
          <p className="text-muted-foreground">{phase.message}</p>
        </Screen>
      );
    case "outside":
      return (
        <Screen title="cc-manabu">
          <p>
            このページは Claude
            デスクトップアプリでインストールして使うアプリです。Claude
            デスクトップアプリでこの artifact を開いてください。
          </p>
        </Screen>
      );
    case "install":
      return (
        <Screen title="cc-manabu をインストール">
          <p>
            cc-manabu は、手元の Claude Code（claude
            コマンド）を動かし、ファイルに会話を保存します。そのため、アプリとしてインストールしたウィンドウの中でだけ動きます。
          </p>
          {phase.state === "available" && (
            <div>
              <Button
                onClick={() => {
                  desktopApi?.install
                    .request()
                    .then((result) => {
                      if (result === "installed") {
                        setPhase({ kind: "install", state: "installed" });
                      }
                    })
                    .catch(() => {});
                }}
              >
                アプリとしてインストール
              </Button>
            </div>
          )}
          {phase.state === "installed" && (
            <p className="text-muted-foreground">
              インストール済みです。Dock（Windows
              ではスタートメニュー）の「cc-manabu」から開いてください。
            </p>
          )}
          {phase.state === "unavailable" && (
            <p className="text-muted-foreground">
              この画面ではインストールできません。Claude
              デスクトップアプリ（macOS / Windows）で開き、artifact
              のメニューから「Install as app」を選んでください。
            </p>
          )}
        </Screen>
      );
    case "permission":
      return (
        <Screen title="フルアクセスを許可してください">
          <p>
            Claude Code
            の起動と、会話のデータ（~/.local/share/cc-manabu）の読み書きに使います。Claude
            Code
            がファイルを編集したりコマンドを実行したりする前には、これまでどおり画面で承認を求めます。
          </p>
          {phase.state === "prompt" && (
            <div>
              <Button
                onClick={() => {
                  desktopApi?.permissions
                    .request(["full-access", "notifications"])
                    .then(() => boot())
                    .catch((error) =>
                      setPhase({ kind: "error", message: errorText(error) }),
                    );
                }}
              >
                許可する
              </Button>
            </div>
          )}
          {phase.state === "denied" && (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">
                フルアクセスが拒否されています。権限の設定から許可してください。
              </p>
              <div>
                <Button
                  variant="outline"
                  onClick={() => {
                    desktopApi?.permissions
                      .manage()
                      .then(() => boot())
                      .catch(() => {});
                  }}
                >
                  権限の設定を開く
                </Button>
              </div>
            </div>
          )}
          {phase.state === "unavailable" && (
            <p className="text-muted-foreground">
              この artifact ではフルアクセスを使えません。組織の外の人が編集した
              artifact
              では許可できないので、自分のアカウントで公開し直したものを使ってください。
            </p>
          )}
        </Screen>
      );
    case "claude-missing":
      return (
        <Screen title="Claude Code が見つかりません">
          <p>{phase.message}</p>
          <p className="text-muted-foreground text-sm">
            探した場所: {phase.tried.join("、")}
          </p>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (session !== undefined && claudePath.trim() !== "") {
                void start(session, undefined, claudePath.trim());
              }
            }}
          >
            <label htmlFor="claude-path" className="text-sm">
              claude のパス（ターミナルで <code>command -v claude</code>{" "}
              を実行すると分かります）
            </label>
            <input
              id="claude-path"
              className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              value={claudePath}
              placeholder="/Users/you/.local/bin/claude"
              onChange={(event) => setClaudePath(event.target.value)}
            />
            <div className="flex gap-2">
              <Button type="submit">このパスで起動</Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => session !== undefined && void start(session)}
              >
                もう一度探す
              </Button>
            </div>
          </form>
        </Screen>
      );
    case "import":
      return (
        <Screen title="CLI 版のデータが見つかりました">
          <p>
            cc-manabu（CLI 版）の会話・タスク・Wiki
            があります。コピーして使い始めますか？
            元のデータはそのまま残り、以後はそれぞれ別に保存されます。
          </p>
          <p className="text-muted-foreground text-sm">
            CLI 版を起動している場合は、先に終了してください。
          </p>
          <div className="flex gap-2">
            <Button
              onClick={() =>
                session !== undefined && void start(session, "cli")
              }
            >
              コピーして始める
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                session !== undefined && void start(session, "new")
              }
            >
              空の状態から始める
            </Button>
          </div>
        </Screen>
      );
    case "error":
      return (
        <Screen title="起動できませんでした">
          <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">
            {phase.message}
          </pre>
          <div>
            <Button onClick={() => void boot()}>もう一度試す</Button>
          </div>
        </Screen>
      );
  }
};

const root = document.getElementById("root");
if (root === null) throw new Error("#root が見つかりません");
createRoot(root).render(
  <StrictMode>
    <Gate />
  </StrictMode>,
);
