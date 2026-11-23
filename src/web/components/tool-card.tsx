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
      return <Terminal className="size-4" />;
    case "Read":
      return <FileText className="size-4" />;
    case "Write":
    case "Edit":
    case "MultiEdit":
      return <Pencil className="size-4" />;
    case "Grep":
    case "Glob":
    case "WebSearch":
      return <Search className="size-4" />;
    case "WebFetch":
      return <Globe className="size-4" />;
    default:
      return <Wrench className="size-4" />;
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
      return <Check className="size-4 text-emerald-600" aria-label="完了" />;
    case "output-error":
      return denied ? (
        <ShieldX className="size-4 text-amber-600" aria-label="拒否" />
      ) : (
        <X className="size-4 text-destructive" aria-label="エラー" />
      );
    default:
      return (
        <Loader2
          className="size-4 animate-spin text-muted-foreground"
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

const InputView = ({
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

/** Claude Code が実行したツール（dynamic-tool パーツ）のカード。 */
export const ToolCard = ({ part }: { part: DynamicToolUIPart }) => {
  const summary = summarizeToolInput(part.toolName, part.input);
  const errorText = part.state === "output-error" ? part.errorText : undefined;
  const denied = errorText !== undefined && /拒否|denied/i.test(errorText);
  return (
    <details className="group rounded-lg border bg-card text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 select-none">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="shrink-0 text-muted-foreground">
          {iconFor(part.toolName)}
        </span>
        <span className="shrink-0 font-medium">{part.toolName}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
          {summary}
        </span>
        <StateIcon state={part.state} denied={denied} />
      </summary>
      <div className="flex flex-col gap-2 border-t px-3 py-2">
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
