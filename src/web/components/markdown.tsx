import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { type ComponentProps, useMemo } from "react";
import remarkBreaks from "remark-breaks";
import {
  type Components,
  defaultComponents,
  defaultRemarkPlugins,
  Streamdown,
} from "streamdown";
import { pageIdFromHref } from "../../wiki/citations.ts";

const plugins = { code, math, mermaid, cjk };

/** チャットでは 1 行ずつの改行をそのまま改行として表示する（CommonMark では空白になる）。 */
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];

/** 本文中の Wiki 引用（`#wiki-<id>`）を、画面内のリンクにする。 */
export type WikiLinks = {
  href: (pageId: string) => string;
  onOpen: (pageId: string) => void;
};

const DefaultLink = defaultComponents.a as (
  props: ComponentProps<"a">,
) => React.ReactNode;

/**
 * チャットのメッセージ本文。GFM・コードハイライト・KaTeX・Mermaid・CJK の強調に対応し、
 * ストリーミング中の書きかけの Markdown（閉じていないコードブロックなど）も崩さずに表示する（#17）。
 */
export const Markdown = ({
  text,
  streaming = false,
  wikiLinks,
}: {
  text: string;
  streaming?: boolean;
  wikiLinks?: WikiLinks;
}) => {
  const components = useMemo<Components | undefined>(
    () =>
      wikiLinks === undefined
        ? undefined
        : {
            a: (props: ComponentProps<"a">) => {
              const pageId = pageIdFromHref(props.href);
              if (pageId === undefined) {
                return <DefaultLink {...props} />;
              }
              return (
                <a
                  href={wikiLinks.href(pageId)}
                  data-wiki-page={pageId}
                  className="font-medium text-primary underline decoration-dotted"
                  onClick={(event) => {
                    event.preventDefault();
                    wikiLinks.onOpen(pageId);
                  }}
                >
                  {props.children}
                </a>
              );
            },
          },
    [wikiLinks],
  );
  return (
    <Streamdown
      plugins={plugins}
      remarkPlugins={remarkPlugins}
      isAnimating={streaming}
      {...(components === undefined ? {} : { components })}
    >
      {text}
    </Streamdown>
  );
};
