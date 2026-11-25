import { parseClaudeVersion } from "../claude/detect.ts";
import type { FullDesktopApi } from "./desktop-api.ts";
import type { SpawnClaude } from "./process-query.ts";

/**
 * デスクトップアプリから `claude` を見つけて起動する方法。
 *
 * アプリから起動したプロセスには、ログインシェルの PATH が引き継がれないことがある
 * （docs/spikes/desktop-artifact.md）。macOS / Linux ではログインシェルを通して探し、
 * 起動するときも同じシェルを通す。
 */
export type ClaudeLaunch = {
  /** `claude` の絶対パス。 */
  path: string;
  version: string | undefined;
  /** login: `$SHELL -lc`、loginInteractive: `$SHELL -lic`、direct: そのまま起動。 */
  mode: "login" | "loginInteractive" | "direct";
  /** login / loginInteractive で使うシェル。 */
  shell: string;
};

export type DetectResult =
  | { found: true; launch: ClaudeLaunch }
  | { found: false; message: string; tried: string[] };

/** POSIX シェルの 1 引数としてクォートする。 */
export const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

const PROBE =
  'command -v claude || true; claude --version 2>/dev/null | head -n 1; printf "PATH=%s\\n" "$PATH"';

/** `command -v claude` と `claude --version` の出力から、パスとバージョンを取り出す。 */
export const parseProbeOutput = (
  output: string,
): { path: string | undefined; version: string | undefined } => {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("PATH="));
  const path = lines.find((line) =>
    /^(\/|[A-Za-z]:\\).*claude(\.exe|\.cmd)?$/i.test(line),
  );
  const versionLine = lines.find((line) =>
    /Claude Code|^\d+\.\d+\.\d+/.test(line),
  );
  return {
    path,
    version:
      versionLine === undefined ? undefined : parseClaudeVersion(versionLine),
  };
};

/** 指定したパスの claude を、そのまま使う（設定で上書きしたとき）。 */
const checkExplicitPath = async (
  desktop: FullDesktopApi,
  path: string,
  shell: string,
  posix: boolean,
): Promise<ClaudeLaunch | undefined> => {
  const command = posix
    ? `${shellQuote(shell)} -lc ${shellQuote(`${shellQuote(path)} --version`)}`
    : `"${path}" --version`;
  const result = await desktop.childProcess
    .exec(command, { timeout: 20_000 })
    .catch(() => undefined);
  const version =
    result === undefined ? undefined : parseClaudeVersion(result.stdout);
  if (version === undefined) return undefined;
  return { path, version, mode: posix ? "login" : "direct", shell };
};

/**
 * `claude` を探す。override（設定したパス）があればそれを確かめ、無ければ
 * ログインシェル → 対話ログインシェル → アプリの環境の順に探す。
 */
export const detectClaude = async (
  desktop: FullDesktopApi,
  options: { platform: string; override?: string },
): Promise<DetectResult> => {
  const posix = options.platform !== "win32";
  const tried: string[] = [];
  let shell = "";
  if (posix) {
    const result = await desktop.childProcess
      .exec('printf "%s" "$SHELL"', { timeout: 5_000 })
      .catch(() => undefined);
    shell =
      result?.stdout.trim() ||
      (options.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  }
  if (options.override !== undefined && options.override.trim() !== "") {
    const launch = await checkExplicitPath(
      desktop,
      options.override.trim(),
      shell,
      posix,
    );
    if (launch !== undefined) return { found: true, launch };
    tried.push(`設定したパス（${options.override}）`);
  }
  const candidates: {
    mode: ClaudeLaunch["mode"];
    label: string;
    command: string;
  }[] = posix
    ? [
        {
          mode: "login",
          label: "ログインシェル",
          command: `${shellQuote(shell)} -lc ${shellQuote(PROBE)}`,
        },
        {
          mode: "loginInteractive",
          label: "対話ログインシェル",
          command: `${shellQuote(shell)} -lic ${shellQuote(PROBE)}`,
        },
        { mode: "direct", label: "アプリの環境", command: PROBE },
      ]
    : [
        {
          mode: "direct",
          label: "cmd.exe",
          command: "where claude & claude --version",
        },
      ];
  for (const candidate of candidates) {
    const result = await desktop.childProcess
      .exec(candidate.command, { timeout: 20_000 })
      .catch(() => undefined);
    tried.push(candidate.label);
    if (result === undefined) continue;
    const { path, version } = parseProbeOutput(
      `${result.stdout}\n${result.stderr}`,
    );
    if (path !== undefined) {
      return {
        found: true,
        launch: { path, version, mode: candidate.mode, shell },
      };
    }
  }
  return {
    found: false,
    message:
      "Claude Code（claude コマンド）が見つかりませんでした。インストールしてログインするか、claude のパスを入力してください。",
    tried,
  };
};

/** 見つけた claude を、同じ方法（ログインシェル経由など）で起動する。 */
export const createSpawnClaude =
  (desktop: FullDesktopApi, launch: ClaudeLaunch): SpawnClaude =>
  (args, { cwd }) => {
    const options = cwd === undefined ? {} : { cwd };
    if (launch.mode === "direct") {
      return desktop.childProcess.spawn(launch.path, args, options);
    }
    // `exec "$0" "$@"` でシェルを claude に置き換える（引数はシェルに解釈させない）
    return desktop.childProcess.spawn(
      launch.shell,
      [
        launch.mode === "login" ? "-lc" : "-lic",
        'exec "$0" "$@"',
        launch.path,
        ...args,
      ],
      options,
    );
  };
