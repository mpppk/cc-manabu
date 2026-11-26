/**
 * 環境変数の読み取り（#188）。新しい名前 `MONET_<名前>` を案内し、改名前の `CC_MANABU_<名前>` も読む。
 * 両方あれば新しい名前を優先する（空文字も「指定した」とみなす）。
 */
export type Env = Record<string, string | undefined>;

export const ENV_PREFIX = "MONET_";
export const LEGACY_ENV_PREFIX = "CC_MANABU_";

export const readEnv = (env: Env, name: string): string | undefined =>
  env[`${ENV_PREFIX}${name}`] ?? env[`${LEGACY_ENV_PREFIX}${name}`];
