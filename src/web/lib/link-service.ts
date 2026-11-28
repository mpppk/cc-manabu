/** 本文のリンクの先のサービス（#275）。アイコンを付けるものだけ。 */
export type LinkService = "cosense" | "slack";

const COSENSE_HOSTS = new Set(["cosen.se", "scrapbox.io"]);

/**
 * リンク先の URL から、Cosense のページか Slack かを判定する。
 * Cosense は cosen.se・scrapbox.io のページ（プロジェクト名とページ名を持つ URL）、
 * Slack は slack.com とそのサブドメイン。それ以外・解釈できない URL は undefined。
 */
export const linkServiceOf = (
  href: string | undefined,
): LinkService | undefined => {
  if (href === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "slack.com" || host.endsWith(".slack.com")) return "slack";
  if (COSENSE_HOSTS.has(host)) {
    const segments = url.pathname.split("/").filter((part) => part !== "");
    return segments.length >= 2 ? "cosense" : undefined;
  }
  return undefined;
};
