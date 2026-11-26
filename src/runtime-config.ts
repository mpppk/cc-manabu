import { readEnv } from "./env.ts";
export type PwaOptions = {
  /** 未指定なら、PWA がインストールされたプロファイルを探す。 */
  readonly profile: string | undefined;
  readonly appId: string | undefined;
};

/** 実行時の設定。環境変数から読み、既定値を持つ。 */
export type RuntimeConfig = {
  /** 待ち受けるホスト。セキュリティのため 127.0.0.1 固定（開発計画 §2.6）。 */
  readonly hostname: "127.0.0.1";
  /** 待ち受けるポート。0 なら空いているポートを OS に選ばせる。 */
  readonly port: number;
  /** 起動時にブラウザを開くか。 */
  readonly openBrowser: boolean;
  /**
   * API にアクセストークンを要求するか。MONET_NO_AUTH=1 で false（デバッグ用）。
   * `bun run dev` の再起動でトークンが変わり、開いているページが 401 になるのを避ける。
   */
  readonly requireToken: boolean;
  /** インストール済みの Chrome PWA を開く設定（--pwa）。 */
  readonly pwa?: PwaOptions;
  /**
   * Chrome のプロファイルとアプリ ID の指定。--pwa が無くても、
   * インストール済みの PWA を自動で探すときに使う（#163）。
   */
  readonly chrome: PwaOptions;
};

const DEFAULT_PORT = 0;

const parsePort = (value: string | undefined): number => {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535
    ? port
    : DEFAULT_PORT;
};

export const loadRuntimeConfig = (
  env: Record<string, string | undefined> = process.env,
  pwa = false,
): RuntimeConfig => {
  const chrome: PwaOptions = {
    profile: readEnv(env, "CHROME_PROFILE")?.trim() || undefined,
    appId: readEnv(env, "CHROME_APP_ID")?.trim() || undefined,
  };
  return {
    hostname: "127.0.0.1",
    port: parsePort(readEnv(env, "PORT")),
    openBrowser: readEnv(env, "NO_OPEN") !== "1",
    requireToken: pwa || readEnv(env, "NO_AUTH") !== "1",
    ...(pwa ? { pwa: chrome } : {}),
    chrome,
  };
};
