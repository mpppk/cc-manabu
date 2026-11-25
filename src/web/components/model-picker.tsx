import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Effort } from "../../chat/chat-service.ts";

const EFFORT_LABELS: Record<Effort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "より高",
  max: "最大",
};

const selectClass =
  "h-8 min-w-0 max-w-40 truncate rounded-md bg-transparent px-2 text-muted-foreground text-xs outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** 送信に使うモデルと effort を選ぶ。effort の選択肢はモデルが対応するものだけ出す。 */
export const ModelPicker = ({
  models,
  model,
  effort,
  disabled,
  onChange,
}: {
  models: ModelInfo[];
  model: string;
  effort: Effort | null;
  disabled?: boolean;
  onChange: (next: { model: string; effort: Effort | null }) => void;
}) => {
  const selected = models.find((m) => m.value === model);
  const efforts = (
    selected?.supportsEffort === true
      ? (selected.supportedEffortLevels ?? [])
      : []
  ) as Effort[];
  // 一覧に無いモデル（取得前・古い会話）も選択肢に残す
  const options =
    selected === undefined
      ? [{ value: model, displayName: model }, ...models]
      : models;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <select
        className={selectClass}
        aria-label="モデル"
        value={model}
        disabled={disabled}
        onChange={(event) => {
          const next = models.find((m) => m.value === event.target.value);
          const nextEfforts = (next?.supportedEffortLevels ?? []) as Effort[];
          onChange({
            model: event.target.value,
            // 新しいモデルが今の effort に対応していなければ既定に戻す
            effort:
              effort !== null && nextEfforts.includes(effort) ? effort : null,
          });
        }}
      >
        {options.map((m) => (
          <option key={m.value} value={m.value}>
            {m.displayName}
          </option>
        ))}
      </select>
      {efforts.length > 0 && (
        <select
          className={selectClass}
          aria-label="effort"
          value={effort ?? ""}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              model,
              effort:
                event.target.value === ""
                  ? null
                  : (event.target.value as Effort),
            })
          }
        >
          <option value="">effort: 既定</option>
          {efforts.map((level) => (
            <option key={level} value={level}>
              effort: {EFFORT_LABELS[level]}
            </option>
          ))}
        </select>
      )}
    </div>
  );
};
