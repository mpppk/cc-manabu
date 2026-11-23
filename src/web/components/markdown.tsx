import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown } from "streamdown";

const plugins = { code, math, mermaid, cjk };

/**
 * チャットのメッセージ本文。GFM・コードハイライト・KaTeX・Mermaid・CJK の強調に対応し、
 * ストリーミング中の書きかけの Markdown（閉じていないコードブロックなど）も崩さずに表示する（#17）。
 */
export const Markdown = ({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) => (
  <Streamdown plugins={plugins} isAnimating={streaming}>
    {text}
  </Streamdown>
);
