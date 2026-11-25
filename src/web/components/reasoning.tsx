import { Brain, ChevronRight } from "lucide-react";

/**
 * reasoning（thinking）の表示。既定では折り畳み、1 行だけ出す。
 * 本文が届かない設定（display: omitted）でも、考えていることだけは分かるようにする。
 */
export const Reasoning = ({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) => {
  const label = streaming ? "考えています…" : "思考";
  if (text.trim() === "") {
    return streaming ? (
      <p className="flex items-center gap-1.5 px-1 py-0.5 text-muted-foreground text-xs">
        <Brain className="size-3.5 animate-pulse" />
        {label}
      </p>
    ) : null;
  }
  return (
    <details className="group/reasoning text-muted-foreground text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-0.5 text-xs select-none hover:bg-accent/60 hover:text-foreground">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/reasoning:rotate-90" />
        <Brain
          className={
            streaming ? "size-3.5 shrink-0 animate-pulse" : "size-3.5 shrink-0"
          }
        />
        <span className="shrink-0">{label}</span>
        {/* 閉じているときも、何を考えていたかの冒頭が分かるようにする */}
        <span className="min-w-0 flex-1 truncate opacity-70 group-open/reasoning:hidden">
          {text.trim().split("\n")[0]}
        </span>
      </summary>
      <div className="mt-1 mb-2 ml-[0.6875rem] whitespace-pre-wrap border-l pl-3">
        {text}
      </div>
    </details>
  );
};
