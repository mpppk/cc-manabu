import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { Effort } from "../../chat/chat-service.ts";
import { cn } from "../lib/utils.ts";

const EFFORT_LABELS: Record<Effort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "より高",
  max: "最大",
};

const selectClass =
  "h-8 min-w-0 max-w-40 truncate rounded-md bg-transparent px-2 text-muted-foreground text-xs outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * モデル選択の最初の階層に並べるシリーズのエイリアス（#183）。この順に表示する。
 * バージョンは Claude Code が解決するので、アプリ側では固定しない。
 */
export const PRIMARY_MODEL_ALIASES = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
] as const;

export type ModelOption = Pick<ModelInfo, "value" | "displayName">;

/**
 * モデルの一覧を、最初の階層（利用可能なシリーズのエイリアス）と「その他のモデル」に分ける。
 * 一覧に無いモデル（取得前・古い会話で選んだもの）も、選択中なら「その他のモデル」に残す。
 */
export const groupModels = (
  models: readonly ModelOption[],
  current: string,
): { primary: ModelOption[]; others: ModelOption[] } => {
  const primary = PRIMARY_MODEL_ALIASES.flatMap((alias) =>
    models.filter((m) => m.value === alias),
  );
  const others = models.filter(
    (m) => !(PRIMARY_MODEL_ALIASES as readonly string[]).includes(m.value),
  );
  const known = models.some((m) => m.value === current);
  // シリーズのエイリアスが無い一覧（Codex など。#265）は、すべて最初の階層に並べる
  if (primary.length === 0 && models.length > 0) {
    return {
      primary: [...models],
      others: known ? [] : [{ value: current, displayName: current }],
    };
  }
  return {
    primary,
    others: known
      ? others
      : [{ value: current, displayName: current }, ...others],
  };
};

/** モデルが対応する effort。 */
const effortsOf = (model: ModelInfo | undefined): Effort[] =>
  (model?.supportsEffort === true
    ? (model.supportedEffortLevels ?? [])
    : []) as Effort[];

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
  const efforts = effortsOf(selected);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ModelMenu
        models={models}
        model={model}
        disabled={disabled}
        onSelect={(value) => {
          const nextEfforts = effortsOf(models.find((m) => m.value === value));
          onChange({
            model: value,
            // 新しいモデルが今の effort に対応していなければ既定に戻す
            effort:
              effort !== null && nextEfforts.includes(effort) ? effort : null,
          });
        }}
      />
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

const itemClass =
  "flex w-full items-center gap-2 whitespace-nowrap rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus:bg-accent";

/** 親メニューの子のうち、フォーカスを移せる項目。 */
const menuItems = (menu: HTMLElement | null): HTMLElement[] =>
  menu === null
    ? []
    : Array.from(
        menu.querySelectorAll<HTMLElement>(
          ":scope > [role^='menuitem'], :scope > div > [role^='menuitem']",
        ),
      );

/** 選択中の項目（無ければ先頭）にフォーカスを移す。 */
const focusSelected = (menu: HTMLElement | null) => {
  const items = menuItems(menu);
  (items.find((item) => item.dataset.selected === "true") ?? items[0])?.focus();
};

/** 上下・Home・End で項目を移る。処理したら true。 */
const moveFocus = (
  event: KeyboardEvent,
  menu: RefObject<HTMLElement | null>,
): boolean => {
  const items = menuItems(menu.current);
  if (items.length === 0) return false;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const at = (index: number) =>
    items[((index % items.length) + items.length) % items.length]?.focus();
  switch (event.key) {
    case "ArrowDown":
      at(current + 1);
      return true;
    case "ArrowUp":
      at(current - 1);
      return true;
    case "Home":
      at(0);
      return true;
    case "End":
      at(items.length - 1);
      return true;
  }
  return false;
};

/**
 * モデルのメニュー（#183）。最初の階層に Fable・Opus・Sonnet・Haiku を並べ、
 * 残り（既定・バージョン指定など）は「その他のモデル」の第 2 階層にまとめる。
 */
const ModelMenu = ({
  models,
  model,
  disabled,
  onSelect,
}: {
  models: ModelInfo[];
  model: string;
  disabled?: boolean;
  onSelect: (value: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const menuId = useId();
  const othersId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const othersRef = useRef<HTMLDivElement>(null);
  const othersTriggerRef = useRef<HTMLButtonElement>(null);
  /** 開いたときにフォーカスする項目（先頭 / 末尾）。 */
  const focusOnOpen = useRef<"first" | "last" | "selected">("selected");
  const focusOthersOnOpen = useRef(false);

  const { primary, others } = groupModels(models, model);
  const label = models.find((m) => m.value === model)?.displayName ?? model;
  const selectedInOthers = others.some((m) => m.value === model);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setOthersOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // 開いた直後のフォーカス。ふだんは選択中の項目（第 2 階層なら「その他のモデル」）に置く
    const items = menuItems(menuRef.current);
    const target =
      focusOnOpen.current === "last"
        ? items.at(-1)
        : focusOnOpen.current === "first"
          ? items[0]
          : undefined;
    if (target === undefined) focusSelected(menuRef.current);
    else target.focus();
    // メニューの外を押したら閉じる
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setOthersOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!othersOpen || !focusOthersOnOpen.current) return;
    focusSelected(othersRef.current);
  }, [othersOpen]);

  const choose = (value: string) => {
    close(true);
    onSelect(value);
  };

  const openOthers = (focus: boolean) => {
    focusOthersOnOpen.current = focus;
    setOthersOpen(true);
    if (focus && othersOpen) {
      // すでに開いているときは effect が動かないので、ここで移す
      focusSelected(othersRef.current);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent) => {
    if (moveFocus(event, menuRef)) {
      event.preventDefault();
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  const onOthersKeyDown = (event: KeyboardEvent) => {
    // 親メニューの上下移動に伝えない
    event.stopPropagation();
    if (moveFocus(event, othersRef)) {
      event.preventDefault();
      return;
    }
    switch (event.key) {
      case "ArrowLeft":
      case "Escape":
        event.preventDefault();
        setOthersOpen(false);
        othersTriggerRef.current?.focus();
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  const radio = (option: ModelOption, inOthers = false) => {
    const checked = option.value === model;
    return (
      <button
        key={option.value}
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        data-selected={checked}
        tabIndex={-1}
        className={itemClass}
        onClick={() => choose(option.value)}
        onPointerEnter={(event) => {
          // 最初の階層の項目にマウスが移ったら、第 2 階層を閉じる
          if (!inOthers && event.pointerType === "mouse") setOthersOpen(false);
        }}
      >
        <Check
          className={cn("size-4 shrink-0", !checked && "invisible")}
          aria-hidden
        />
        {option.displayName}
      </button>
    );
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        className={cn(selectClass, "flex items-center gap-1")}
        aria-label={`モデル: ${label}`}
        title={`モデル: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        data-model={model}
        onClick={() => {
          focusOnOpen.current = "selected";
          if (open) close(false);
          else setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            focusOnOpen.current = event.key === "ArrowDown" ? "first" : "last";
            setOpen(true);
          }
        }}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="モデル"
          tabIndex={-1}
          className="absolute bottom-full left-0 z-50 mb-1 flex min-w-44 flex-col rounded-md border bg-background p-1 shadow-md"
          onKeyDown={onMenuKeyDown}
        >
          {primary.map((option) => radio(option))}
          {others.length > 0 && (
            <div className="relative">
              {primary.length > 0 && (
                <hr className="-mx-1 my-1 h-px border-0 bg-border" />
              )}
              <button
                ref={othersTriggerRef}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-haspopup="menu"
                aria-expanded={othersOpen}
                aria-controls={othersOpen ? othersId : undefined}
                data-selected={selectedInOthers}
                className={cn(itemClass, othersOpen && "bg-accent")}
                onClick={() => {
                  if (othersOpen) setOthersOpen(false);
                  else openOthers(true);
                }}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") openOthers(false);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "ArrowRight" ||
                    event.key === "Enter" ||
                    event.key === " "
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    openOthers(true);
                  }
                }}
              >
                <Check
                  className={cn(
                    "size-4 shrink-0",
                    !selectedInOthers && "invisible",
                  )}
                  aria-hidden
                />
                <span className="flex-1">その他のモデル</span>
                <ChevronRight className="size-4 shrink-0" aria-hidden />
              </button>
              {othersOpen && (
                <div
                  ref={othersRef}
                  id={othersId}
                  role="menu"
                  aria-label="その他のモデル"
                  tabIndex={-1}
                  className="flex max-h-[40vh] flex-col overflow-y-auto pl-4 sm:absolute sm:bottom-0 sm:left-full sm:z-50 sm:ml-1 sm:max-h-[60vh] sm:min-w-44 sm:rounded-md sm:border sm:bg-background sm:p-1 sm:shadow-md"
                  onKeyDown={onOthersKeyDown}
                >
                  {others.map((option) => radio(option, true))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
