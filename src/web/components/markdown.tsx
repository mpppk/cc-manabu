import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { type ComponentProps, useMemo, useRef } from "react";
import remarkBreaks from "remark-breaks";
import {
  type Components,
  defaultComponents,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
} from "streamdown";
import {
  type CitationSource,
  citationNumberFromHref,
} from "../../chat/citations.ts";
import { pageIdFromHref } from "../../wiki/citations.ts";
import type { TermMatch } from "../../wiki/term-matcher.ts";
import { rehypeCosenseLinks } from "../lib/rehype-cosense-links.ts";
import { isPendingTermId, rehypeWikiTerms } from "../lib/rehype-wiki-terms.ts";
import { CitationBadge } from "./citation-badge.tsx";
import { WikiTerm } from "./wiki-term.tsx";

const plugins = { code, math, mermaid, cjk };

/** チャットでは 1 行ずつの改行をそのまま改行として表示する（CommonMark では空白になる）。 */
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];

/** 本文中の Wiki 引用（`#wiki-<id>`）を、画面内のリンクにする。 */
export type WikiLinks = {
  href: (pageId: string) => string;
  onOpen: (pageId: string) => void;
};

const matcherKeys = new WeakMap<object, string>();
let nextMatcherKey = 0;
/** 照合関数ごとに一意なキー。 */
const matcherKey = (matcher: object): string => {
  let key = matcherKeys.get(matcher);
  if (key === undefined) {
    key = `terms-${nextMatcherKey++}`;
    matcherKeys.set(matcher, key);
  }
  return key;
};

/** rehype-wiki-terms が付けた `data-wiki-term` の span を、用語の説明にする。 */
const TermSpan = ({
  node: _node,
  ...props
}: ComponentProps<"span"> & { node?: unknown; "data-wiki-term"?: string }) => {
  const pageId = props["data-wiki-term"];
  if (pageId === undefined) return <span {...props} />;
  // ページを AI で作っている最中の語句
  if (isPendingTermId(pageId)) {
    return (
      <span
        data-wiki-term-pending=""
        className="wiki-term-generating"
        title="ノートを作成しています…"
      >
        {props.children}
      </span>
    );
  }
  return <WikiTerm pageId={pageId}>{props.children}</WikiTerm>;
};

const DefaultLink = defaultComponents.a as (
  props: ComponentProps<"a">,
) => React.ReactNode;

/**
 * チャットのメッセージ本文。GFM・コードハイライト・KaTeX・Mermaid・CJK の強調に対応し、
 * ストリーミング中の書きかけの Markdown（閉じていないコードブロックなど）も崩さずに表示する（#17）。
 *
 * - wikiLinks: 回答の Wiki 引用（#79）を画面内のリンクにする
 * - termMatcher: 本文の用語を Wiki の用語ページに結び付ける（#81）。コード・数式・リンクの中は対象外
 */
export const Markdown = ({
  text,
  streaming = false,
  cosenseLinks = false,
  wikiLinks,
  termMatcher,
  citations,
}: {
  text: string;
  streaming?: boolean;
  cosenseLinks?: boolean;
  wikiLinks?: WikiLinks;
  termMatcher?: (text: string) => TermMatch[];
  /** 本文の出典（`#cite-<n>` のリンクをバッジにする。#258）。 */
  citations?: readonly CitationSource[] | undefined;
}) => {
  // 上書きするコンポーネントの型が描画のたびに変わると、中の状態（用語の説明の開閉など）が消える。
  // 型は「使うかどうか」だけで決め、wikiLinks の中身は ref から読む
  const linksRef = useRef(wikiLinks);
  linksRef.current = wikiLinks;
  const citationsRef = useRef(citations);
  citationsRef.current = citations;
  const hasLinks = wikiLinks !== undefined;
  const hasTerms = termMatcher !== undefined;
  const hasCitations = citations !== undefined && citations.length > 0;
  const components = useMemo<Components | undefined>(() => {
    if (!hasLinks && !hasTerms && !cosenseLinks && !hasCitations) {
      return undefined;
    }
    return {
      ...(hasLinks || cosenseLinks || hasCitations
        ? {
            a: (
              props: ComponentProps<"a"> & { "data-cosense-link"?: boolean },
            ) => {
              if (
                cosenseLinks &&
                props["data-cosense-link"] &&
                props.href?.startsWith("https://cosen.se/")
              ) {
                return (
                  <a
                    href={props.href}
                    className="wrap-anywhere font-medium text-primary underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {props.children}
                  </a>
                );
              }
              if (
                cosenseLinks &&
                props.href === "streamdown:incomplete-link" &&
                typeof props.children === "string" &&
                /^\/[\w-]+\//.test(props.children)
              ) {
                return `[${props.children}`;
              }
              const n = citationNumberFromHref(props.href);
              const source =
                n === undefined
                  ? undefined
                  : citationsRef.current?.find((item) => item.n === n);
              if (source !== undefined) {
                return (
                  <CitationBadge
                    source={source}
                    wikiHref={linksRef.current?.href}
                    onOpenWiki={(pageId) => linksRef.current?.onOpen(pageId)}
                  />
                );
              }
              const pageId = pageIdFromHref(props.href);
              const links = linksRef.current;
              if (pageId === undefined || links === undefined) {
                return <DefaultLink {...props} />;
              }
              return (
                <a
                  href={links.href(pageId)}
                  data-wiki-page={pageId}
                  className="font-medium text-primary underline decoration-dotted"
                  onClick={(event) => {
                    event.preventDefault();
                    linksRef.current?.onOpen(pageId);
                  }}
                >
                  {props.children}
                </a>
              );
            },
          }
        : {}),
      ...(hasTerms ? { span: TermSpan } : {}),
    };
  }, [cosenseLinks, hasLinks, hasTerms, hasCitations]);
  const rehypePlugins = useMemo(
    () =>
      termMatcher === undefined && !cosenseLinks
        ? undefined
        : [
            ...Object.values(defaultRehypePlugins),
            ...(cosenseLinks ? [rehypeCosenseLinks] : []),
            ...(termMatcher === undefined
              ? []
              : [rehypeWikiTerms(termMatcher)]),
          ],
    [cosenseLinks, termMatcher],
  );
  return (
    <Streamdown
      // Streamdown は rehypePlugins の変化では描き直さないので、用語の一覧が変わったら作り直す
      key={`${cosenseLinks}-${termMatcher === undefined ? "plain" : matcherKey(termMatcher)}`}
      plugins={plugins}
      remarkPlugins={remarkPlugins}
      isAnimating={streaming}
      {...(components === undefined ? {} : { components })}
      {...(rehypePlugins === undefined ? {} : { rehypePlugins })}
    >
      {text}
    </Streamdown>
  );
};
