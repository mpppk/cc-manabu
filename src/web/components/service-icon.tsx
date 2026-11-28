import type { LinkService } from "../lib/link-service.ts";

/** Cosense のアイコン（緑の丸に白い C）。 */
const CosenseIcon = () => (
  <svg viewBox="0 0 16 16" className="size-full" aria-hidden="true">
    <circle cx="8" cy="8" r="8" fill="#00b06b" />
    <path
      d="M10.9 5.6A3.6 3.6 0 1 0 10.9 10.4"
      fill="none"
      stroke="#fff"
      strokeWidth="1.9"
      strokeLinecap="round"
    />
  </svg>
);

/** Slack のアイコン（4 色の羽根）。 */
const SlackIcon = () => (
  <svg viewBox="0 0 16 16" className="size-full" aria-hidden="true">
    <rect x="6.2" y="0.8" width="2.6" height="7" rx="1.3" fill="#36c5f0" />
    <rect x="8.2" y="6.2" width="7" height="2.6" rx="1.3" fill="#2eb67d" />
    <rect x="7.2" y="8.2" width="2.6" height="7" rx="1.3" fill="#ecb22e" />
    <rect x="0.8" y="7.2" width="7" height="2.6" rx="1.3" fill="#e01e5a" />
  </svg>
);

/**
 * 本文のリンクの先頭に付ける、リンク先のサービスのアイコン（#275）。
 * 装飾なので読み上げない（リンクのラベルを読み上げる）。
 */
export const ServiceIcon = ({ service }: { service: LinkService }) => (
  <span
    aria-hidden="true"
    data-link-service={service}
    className="mr-0.5 inline-block size-[1em] translate-y-[0.125em] align-baseline"
  >
    {service === "cosense" ? <CosenseIcon /> : <SlackIcon />}
  </span>
);
