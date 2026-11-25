export type PwaOptions = {
  readonly profile: string;
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
   * API にアクセストークンを要求するか。CC_MANABU_NO_AUTH=1 で false（デバッグ用）。
   * `bun run dev` の再起動でトークンが変わり、開いているページが 401 になるのを避ける。
   */
  readonly requireToken: boolean;
  /** インストール済みの Chrome PWA を開く設定（--pwa）。 */
  readonly pwa?: PwaOptions;
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
): RuntimeConfig => ({
  hostname: "127.0.0.1",
  port: parsePort(env.CC_MANABU_PORT),
  openBrowser: env.CC_MANABU_NO_OPEN !== "1",
  requireToken: pwa || env.CC_MANABU_NO_AUTH !== "1",
  ...(pwa
    ? {
        pwa: {
          profile: env.CC_MANABU_CHROME_PROFILE?.trim() || "Default",
          appId: env.CC_MANABU_CHROME_APP_ID?.trim() || undefined,
        },
      }
    : {}),
});
