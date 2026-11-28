import { ExternalLink } from "lucide-react";
import { useId, useState } from "react";
import {
  CITATION_KIND_LABELS,
  type CitationSource,
} from "../../chat/citations.ts";

/**
 * 本文の出典のバッジ（#258）。番号を出し、ホバー・フォーカスで種類・タイトル・抜粋を出す。
 * 押すと出典を開く（Cosense のページ・Slack の発言・Web のページは新しいタブ、Wiki のノートは右側のペイン）。
 */
export const CitationBadge = ({
  source,
  wikiHref,
  onOpenWiki,
}: {
  source: CitationSource;
  /** Wiki のノートの画面内のリンク。開けなければ undefined。 */
  wikiHref?: ((pageId: string) => string) | undefined;
  onOpenWiki?: ((pageId: string) => void) | undefined;
}) => {
  const [open, setOpen] = useState(false);
  const cardId = useId();
  const wiki = source.kind === "wiki" && source.pageId !== undefined;
  const label = `出典 ${source.n}: ${CITATION_KIND_LABELS[source.kind]}${
    source.title === undefined ? "" : `「${source.title}」`
  }`;
  const href = wiki
    ? wikiHref?.(source.pageId ?? "")
    : source.kind === "wiki"
      ? undefined
      : source.url;
  const hover = {
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
  };
  const className =
    "mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-sm bg-sky-500/15 px-1 align-super font-medium text-[10px] text-sky-700 leading-none no-underline hover:bg-sky-500/25 focus-visible:outline-2 focus-visible:outline-ring dark:text-sky-300";
  return (
    <span className="relative inline">
      {href === undefined ? (
        <button
          type="button"
          data-citation={source.n}
          aria-label={label}
          aria-describedby={open ? cardId : undefined}
          className={className}
          {...hover}
          onClick={() => setOpen((current) => !current)}
        >
          {source.n}
        </button>
      ) : (
        <a
          {...hover}
          href={href}
          data-citation={source.n}
          {...(wiki ? { "data-wiki-page": source.pageId } : {})}
          aria-label={label}
          aria-describedby={open ? cardId : undefined}
          className={className}
          {...(wiki
            ? {
                onClick: (event: React.MouseEvent) => {
                  event.preventDefault();
                  if (source.pageId !== undefined) onOpenWiki?.(source.pageId);
                },
              }
            : { target: "_blank", rel: "noreferrer" })}
        >
          {source.n}
        </a>
      )}
      {open && (
        <span
          id={cardId}
          role="tooltip"
          className="absolute top-full left-0 z-30 mt-1 flex w-72 max-w-[80vw] flex-col gap-1 rounded-md border bg-background p-2 text-left font-normal text-foreground text-xs shadow-md"
        >
          <span className="text-muted-foreground">
            {CITATION_KIND_LABELS[source.kind]}
            {source.kind === "wiki" ? " のノート" : ""}
          </span>
          {source.title !== undefined && (
            <span className="font-medium">{source.title}</span>
          )}
          {source.excerpt !== undefined && (
            <span className="line-clamp-3 text-muted-foreground">
              {source.excerpt}
            </span>
          )}
          {!wiki && source.kind !== "wiki" && (
            <span className="flex items-center gap-1 break-all text-muted-foreground">
              <ExternalLink aria-hidden className="size-3 shrink-0" />
              {source.url}
            </span>
          )}
        </span>
      )}
    </span>
  );
};
