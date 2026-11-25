import type { DynamicToolUIPart } from "ai";
import {
  Check,
  ChevronRight,
  FileText,
  Globe,
  Loader2,
  Pencil,
  Search,
  ShieldX,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  outputToText,
  simpleDiff,
  summarizeToolInput,
  truncate,
} from "../lib/tool-display.ts";
import { cn } from "../lib/utils.ts";

const OUTPUT_PREVIEW_CHARS = 4000;

const iconFor = (toolName: string): ReactNode => {
  switch (toolName) {
    case "Bash":
      return <Terminal className="size-3.5" />;
    case "Read":
      return <FileText className="size-3.5" />;
    case "Write":
    case "Edit":
    case "MultiEdit":
      return <Pencil className="size-3.5" />;
    case "Grep":
    case "Glob":
    case "WebSearch":
      return <Search className="size-3.5" />;
    case "WebFetch":
      return <Globe className="size-3.5" />;
    default:
      return <Wrench className="size-3.5" />;
  }
};

const StateIcon = ({
  state,
  denied,
}: {
  state: DynamicToolUIPart["state"];
  denied: boolean;
}) => {
  switch (state) {
    case "output-available":
      return <Check className="size-3.5 text-emerald-600" aria-label="完了" />;
    case "output-error":
      return denied ? (
        <ShieldX className="size-3.5 text-amber-600" aria-label="拒否" />
      ) : (
        <X className="size-3.5 text-destructive" aria-label="エラー" />
      );
    default:
      return (
        <Loader2
          className="size-3.5 animate-spin text-muted-foreground"
          aria-label="実行中"
        />
      );
  }
};

const Pre = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <pre
    className={cn(
      "max-h-80 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-all",
      className,
    )}
  >
    {children}
  </pre>
);

const Output = ({ text }: { text: string }) => {
  const [full, setFull] = useState(false);
  const shown = full
    ? { text, truncated: false }
    : truncate(text, OUTPUT_PREVIEW_CHARS);
  return (
    <div className="flex flex-col gap-1">
      <Pre>{shown.text === "" ? "（出力なし）" : shown.text}</Pre>
      {shown.truncated && (
        <button
          type="button"
          className="self-start text-muted-foreground text-xs underline"
          onClick={() => setFull(true)}
        >
          全文を表示（{text.length.toLocaleString()} 文字）
        </button>
      )}
    </div>
  );
};

const Diff = ({ before, after }: { before: string; after: string }) => (
  <Pre className="whitespace-pre">
    {simpleDiff(before, after).map((line, i) => (
      <div
        // biome-ignore lint/suspicious/noArrayIndexKey: 行の順番は変わらない
        key={i}
        className={cn(
          line.kind === "removed" &&
            "bg-red-500/10 text-red-700 dark:text-red-400",
          line.kind === "added" &&
            "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        )}
      >
        {line.kind === "removed" ? "- " : line.kind === "added" ? "+ " : "  "}
        {line.text}
      </div>
    ))}
  </Pre>
);

export const InputView = ({
  toolName,
  input,
}: {
  toolName: string;
  input: unknown;
}) => {
  const record = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;
  if (
    toolName === "Edit" &&
    typeof record.old_string === "string" &&
    typeof record.new_string === "string"
  ) {
    return <Diff before={record.old_string} after={record.new_string} />;
  }
  if (toolName === "Write" && typeof record.content === "string") {
    return <Output text={record.content} />;
  }
  if (toolName === "Bash" && typeof record.command === "string") {
    return <Pre>$ {record.command}</Pre>;
  }
  return <Pre>{JSON.stringify(input, null, 2)}</Pre>;
};

/** ツールが拒否されたか（エラーの文面で見分ける）。 */
export const isDenied = (part: DynamicToolUIPart): boolean =>
  part.state === "output-error" && /拒否|denied/i.test(part.errorText ?? "");

/** Claude Code が実行したツール（dynamic-tool パーツ）。1 行で出し、押すと入力と出力を開く。 */
export const ToolCard = ({ part }: { part: DynamicToolUIPart }) => {
  const summary = summarizeToolInput(part.toolName, part.input);
  const errorText = part.state === "output-error" ? part.errorText : undefined;
  const denied = isDenied(part);
  return (
    <details className="group/tool text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-0.5 text-muted-foreground select-none hover:bg-accent/60 hover:text-foreground">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/tool:rotate-90" />
        <span className="shrink-0">{iconFor(part.toolName)}</span>
        <span className="shrink-0 font-medium text-foreground/80 text-xs">
          {part.toolName}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {summary}
        </span>
        <StateIcon state={part.state} denied={denied} />
      </summary>
      <div className="mt-1 mb-2 ml-[0.6875rem] flex flex-col gap-2 border-l pl-3">
        <div>
          <p className="mb-1 text-muted-foreground text-xs">入力</p>
          <InputView toolName={part.toolName} input={part.input} />
        </div>
        {part.state === "output-available" && (
          <div>
            <p className="mb-1 text-muted-foreground text-xs">出力</p>
            <Output text={outputToText(part.output)} />
          </div>
        )}
        {errorText !== undefined && (
          <div>
            <p className="mb-1 text-muted-foreground text-xs">
              {denied ? "拒否" : "エラー"}
            </p>
            <Pre className="text-destructive">{errorText}</Pre>
          </div>
        )}
      </div>
    </details>
  );
};
