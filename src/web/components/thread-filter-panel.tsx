import { Filter, Plus, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  describeFilter,
  emptyFilter,
  FIELD_LABELS,
  FIELDS,
  type FilterField,
  type FilterGroup,
  type FilterRule,
  type FilterState,
  isEmptyFilter,
  isFilterGroupItem,
  newRule,
  sameFilter,
  updateIn,
  valueOptions,
} from "../lib/thread-filter.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";

type Environments = readonly { id: string; name: string }[];

const SELECT_CLASS =
  "h-7 min-w-0 rounded-md border bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 1 つの条件（項目・比較・値）。狭い左ペインでも読めるよう、折り返して並べる。 */
const RuleEditor = ({
  rule,
  environments,
  onChange,
  onRemove,
}: {
  rule: FilterRule;
  environments: Environments;
  onChange: (rule: FilterRule) => void;
  onRemove: () => void;
}) => (
  <li
    data-filter-rule
    className="flex flex-wrap items-center gap-1 rounded-md border bg-background p-1"
  >
    <select
      aria-label="項目"
      className={cn(SELECT_CLASS, "flex-1")}
      value={rule.field}
      onChange={(event) => {
        const field = event.target.value as FilterField;
        onChange({ ...newRule(field, environments), id: rule.id });
      }}
    >
      {FIELDS.map((field) => (
        <option key={field} value={field}>
          {FIELD_LABELS[field]}
        </option>
      ))}
    </select>
    <select
      aria-label="比較"
      className={SELECT_CLASS}
      value={rule.operator}
      onChange={(event) =>
        onChange({
          ...rule,
          operator: event.target.value === "!=" ? "!=" : "=",
        })
      }
    >
      <option value="=">=</option>
      <option value="!=">≠</option>
    </select>
    <select
      aria-label="値"
      className={cn(SELECT_CLASS, "flex-1")}
      value={rule.value}
      onChange={(event) => onChange({ ...rule, value: event.target.value })}
    >
      {valueOptions(rule.field, environments).map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label="条件を削除"
      onClick={onRemove}
    >
      <X className="size-3.5" />
    </Button>
  </li>
);

/**
 * 条件のグループ。AND（すべてに一致）・OR（いずれかに一致）を選び、条件と、
 * 1 段のグループ（例: 環境 = 開発 AND（生成中 OR 未読））を入れられる。
 */
const GroupEditor = ({
  group,
  environments,
  nested,
  onChange,
  onRemove,
}: {
  group: FilterGroup;
  environments: Environments;
  nested: boolean;
  onChange: (group: FilterGroup) => void;
  onRemove?: () => void;
}) => {
  const replace = (id: string, next: FilterRule | FilterGroup | undefined) =>
    onChange(updateIn(group, id, () => next));
  return (
    <div
      data-filter-group={nested ? "nested" : "root"}
      className={cn(
        "flex flex-col gap-1.5",
        nested && "rounded-md border border-dashed bg-muted/40 p-1.5",
      )}
    >
      <div className="flex items-center gap-1">
        <select
          aria-label={nested ? "グループの組み合わせ" : "条件の組み合わせ"}
          className={cn(SELECT_CLASS, "flex-1")}
          value={group.combinator}
          onChange={(event) =>
            onChange({
              ...group,
              combinator: event.target.value === "or" ? "or" : "and",
            })
          }
        >
          <option value="and">すべてに一致（AND）</option>
          <option value="or">いずれかに一致（OR）</option>
        </select>
        {onRemove !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="グループを削除"
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
      {group.rules.length > 0 && (
        <ul className="flex flex-col gap-1">
          {group.rules.map((item) =>
            isFilterGroupItem(item) ? (
              <li key={item.id}>
                <GroupEditor
                  group={item}
                  environments={environments}
                  nested
                  onChange={(next) => replace(item.id, next)}
                  onRemove={() => replace(item.id, undefined)}
                />
              </li>
            ) : (
              <RuleEditor
                key={item.id}
                rule={item}
                environments={environments}
                onChange={(next) => replace(item.id, next)}
                onRemove={() => replace(item.id, undefined)}
              />
            ),
          )}
        </ul>
      )}
      <div className="flex flex-wrap gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() =>
            onChange({
              ...group,
              rules: [...group.rules, newRule("environment", environments)],
            })
          }
        >
          <Plus className="size-3.5" />
          {nested ? "グループに条件を追加" : "条件を追加"}
        </Button>
        {!nested && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() =>
              onChange({
                ...group,
                rules: [
                  ...group.rules,
                  {
                    ...emptyFilter(),
                    combinator: "or",
                    rules: [newRule("threadState", environments)],
                  },
                ],
              })
            }
          >
            <Plus className="size-3.5" />
            グループを追加
          </Button>
        )}
      </div>
    </div>
  );
};

/** 名前を入れて決める欄（保存・名前の変更）。 */
const NameForm = ({
  label,
  submitLabel,
  initial,
  onSubmit,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) => {
  const [name, setName] = useState(initial);
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "") onSubmit(name.trim());
      }}
    >
      <input
        aria-label={label}
        className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
        value={name}
        // biome-ignore lint/a11y/noAutofocus: 保存・名前の変更を押した直後に入力できるようにする
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <Button
        type="submit"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={name.trim() === ""}
      >
        {submitLabel}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={onCancel}
      >
        キャンセル
      </Button>
    </form>
  );
};

/**
 * 左ペインの絞り込み（#256）。「フィルタ」ボタンから開き、条件を AND／OR で組み合わせる。
 * 条件は変えたその場で一覧に効き、名前を付けて複数保存して切り替えられる。
 * 保存済みの絞り込みの条件は、上書き保存・新規保存を選んだときだけ書き換える。
 */
export const ThreadFilterPanel = ({
  state,
  environments,
  onChange,
}: {
  state: FilterState;
  environments: Environments;
  onChange: (state: FilterState) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<"save" | "rename">();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const applied = state.saved.find((item) => item.id === state.appliedId);
  const modified =
    applied !== undefined && !sameFilter(applied.filter, state.current);
  const empty = isEmptyFilter(state.current);
  const summary = describeFilter(state.current, environments);
  const name =
    applied === undefined
      ? empty
        ? undefined
        : summary
      : `${applied.name}${modified ? "（変更あり）" : ""}`;

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setNaming(undefined);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // パネルの外を押したら閉じる
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setNaming(undefined);
      }
    };
    // 保存したあとなど、パネルの外にフォーカスがあっても Escape で閉じる
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      setNaming(undefined);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const setCurrent = (current: FilterGroup) => onChange({ ...state, current });
  const apply = (id: string) => {
    if (id === "") {
      onChange({ ...state, current: emptyFilter(), appliedId: undefined });
      return;
    }
    const saved = state.saved.find((item) => item.id === id);
    if (saved !== undefined) {
      onChange({ ...state, current: saved.filter, appliedId: saved.id });
    }
  };

  const label = name === undefined ? "フィルタ" : `フィルタ（${name}）`;
  let actions: ReactNode;
  if (naming === "save") {
    actions = (
      <NameForm
        label="絞り込みの名前"
        submitLabel="保存"
        initial=""
        onCancel={() => setNaming(undefined)}
        onSubmit={(newName) => {
          const id = crypto.randomUUID();
          onChange({
            ...state,
            saved: [
              ...state.saved,
              { id, name: newName, filter: state.current },
            ],
            appliedId: id,
          });
          setNaming(undefined);
        }}
      />
    );
  } else if (naming === "rename" && applied !== undefined) {
    actions = (
      <NameForm
        label="絞り込みの新しい名前"
        submitLabel="変更"
        initial={applied.name}
        onCancel={() => setNaming(undefined)}
        onSubmit={(newName) => {
          onChange({
            ...state,
            saved: state.saved.map((item) =>
              item.id === applied.id ? { ...item, name: newName } : item,
            ),
          });
          setNaming(undefined);
        }}
      />
    );
  } else {
    actions = (
      <div className="flex flex-wrap gap-1">
        {applied !== undefined && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={!modified}
            onClick={() =>
              onChange({
                ...state,
                saved: state.saved.map((item) =>
                  item.id === applied.id
                    ? { ...item, filter: state.current }
                    : item,
                ),
              })
            }
          >
            上書き保存
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={empty}
          onClick={() => setNaming("save")}
        >
          名前を付けて保存
        </Button>
        {applied !== undefined && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setNaming("rename")}
            >
              名前を変更
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-destructive text-xs"
              onClick={() =>
                onChange({
                  ...state,
                  saved: state.saved.filter((item) => item.id !== applied.id),
                  appliedId: undefined,
                })
              }
            >
              削除
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative px-2 pb-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          ref={triggerRef}
          variant={empty ? "ghost" : "secondary"}
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2 text-xs"
          aria-label={label}
          title={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => (open ? close(false) : setOpen(true))}
        >
          <Filter />
          フィルタ
        </Button>
        {name !== undefined && (
          <span
            className="min-w-0 truncate text-muted-foreground text-xs"
            title={summary}
            data-testid="filter-summary"
          >
            {name}
          </span>
        )}
      </div>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="絞り込み"
          className="absolute top-full left-2 z-50 mt-1 flex w-[min(24rem,calc(100vw-1rem))] flex-col gap-2 rounded-md border bg-background p-2 shadow-md"
        >
          <label className="flex items-center gap-1.5 text-xs">
            <span className="shrink-0 text-muted-foreground">
              保存した絞り込み
            </span>
            <select
              className={cn(SELECT_CLASS, "flex-1")}
              value={applied?.id ?? ""}
              onChange={(event) => apply(event.target.value)}
            >
              <option value="">条件なし</option>
              {state.saved.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {!empty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 self-start px-2 text-xs"
              onClick={() => apply("")}
            >
              <X className="size-3.5" />
              条件なしに戻す
            </Button>
          )}
          <GroupEditor
            group={state.current}
            environments={environments}
            nested={false}
            onChange={setCurrent}
          />
          <p className="text-muted-foreground text-xs">
            {empty
              ? "条件を追加すると、左ペインのスレッドを絞り込みます。アーカイブしたスレッドは、アーカイブの条件を指定したときに出ます。"
              : summary}
          </p>
          <div className="border-t pt-2">{actions}</div>
        </div>
      )}
    </div>
  );
};
