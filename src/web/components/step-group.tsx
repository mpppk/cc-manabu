import { ChevronRight, ListTree } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cn } from "../lib/utils.ts";

/**
 * 続けて行った思考・ツールの実行のまとまり。1 行の見出しで開閉する。
 * 実行中（live）は開き、回答が先に進むと閉じる。利用者が開閉したらそれに従う。
 */
export const StepGroup = ({
  count,
  breakdown,
  live,
  status,
  children,
}: {
  count: number;
  /** 内訳（「思考 2・Bash 3」）。 */
  breakdown: string;
  live: boolean;
  /** 見出しの右に出す状態（実行中・エラーなど）。 */
  status?: ReactNode;
  children: ReactNode;
}) => {
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? live;
  const id = useId();
  return (
    <div className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-muted-foreground text-xs hover:bg-accent/60 hover:text-foreground"
        onClick={() => setChosen(!open)}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <ListTree className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {count} 件の手順（{breakdown}）
        </span>
        {status}
      </button>
      <div
        id={id}
        hidden={!open}
        className="mt-0.5 ml-[0.6875rem] flex flex-col gap-0.5 border-l pl-2"
      >
        {children}
      </div>
    </div>
  );
};
