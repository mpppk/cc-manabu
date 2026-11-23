import { Brain, ChevronRight } from "lucide-react";

/**
 * reasoning（thinking）の表示。既定では折り畳む。
 * 本文が届かない設定（display: omitted）でも、考えていることだけは分かるようにする。
 */
export const Reasoning = ({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) => {
  const label = streaming ? "考えています…" : "思考の過程";
  if (text.trim() === "") {
    return streaming ? (
      <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
        <Brain className="size-4 animate-pulse" />
        {label}
      </p>
    ) : null;
  }
  return (
    <details className="group text-muted-foreground text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none hover:text-foreground">
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
        <Brain className={streaming ? "size-4 animate-pulse" : "size-4"} />
        {label}
      </summary>
      <div className="mt-2 whitespace-pre-wrap border-l-2 pl-3">{text}</div>
    </details>
  );
};
