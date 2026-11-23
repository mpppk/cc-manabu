const STORAGE_KEY = "cc-manabu:token";

/**
 * 起動時トークンを取り出す。
 * URL の fragment（#token=...）にあれば sessionStorage に移し、アドレスバーから消す（開発計画 §2.6）。
 */
export const takeToken = (
  location: Pick<Location, "hash" | "pathname" | "search">,
  storage: Pick<Storage, "getItem" | "setItem">,
  replaceUrl: (url: string) => void,
): string | undefined => {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const fromHash = params.get("token");
  if (fromHash !== null && fromHash !== "") {
    storage.setItem(STORAGE_KEY, fromHash);
    replaceUrl(`${location.pathname}${location.search}`);
    return fromHash;
  }
  return storage.getItem(STORAGE_KEY) ?? undefined;
};
