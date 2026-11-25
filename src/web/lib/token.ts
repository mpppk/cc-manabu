const STORAGE_KEY = "cc-manabu:token";

export const launchTokenFromHash = (hash: string): string | undefined =>
  new URLSearchParams(hash.replace(/^#/, "")).get("token") || undefined;

/**
 * 起動時トークンを取り出す。
 * URL の fragment（#token=...）にあれば sessionStorage に移し、アドレスバーから消す（開発計画 §2.6）。
 */
export const takeToken = (
  location: Pick<Location, "hash" | "pathname" | "search">,
  storage: Pick<Storage, "getItem" | "setItem">,
  replaceUrl: (url: string) => void,
): string | undefined => {
  const fromHash = launchTokenFromHash(location.hash);
  if (fromHash !== undefined) {
    storage.setItem(STORAGE_KEY, fromHash);
    replaceUrl(`${location.pathname}${location.search}`);
    return fromHash;
  }
  return storage.getItem(STORAGE_KEY) ?? undefined;
};

/** Web UI が API を呼ぶときの認証のしかた。 */
export type Access =
  /** 起動時トークンを付けて呼ぶ（通常）。 */
  | { kind: "token"; token: string }
  /** トークンなしで呼ぶ（サーバが CC_MANABU_NO_AUTH=1 で起動しているとき）。 */
  | { kind: "open" }
  /** トークンが無く、サーバも要求している。 */
  | { kind: "missing" };

/**
 * 認証のしかたを決める。トークンがあればそれを使い、無いときだけサーバに要否を問い合わせる。
 * 問い合わせに失敗したり応答が不正なら、トークンが要るものとして扱う。
 */
export const resolveAccess = async (
  token: string | undefined,
  fetchAuthMode: () => Promise<unknown>,
): Promise<Access> => {
  if (token !== undefined) {
    return { kind: "token", token };
  }
  const mode = await fetchAuthMode().catch(() => undefined);
  const open =
    typeof mode === "object" &&
    mode !== null &&
    "tokenRequired" in mode &&
    mode.tokenRequired === false;
  return open ? { kind: "open" } : { kind: "missing" };
};
