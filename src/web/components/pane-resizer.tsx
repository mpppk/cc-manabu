import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { cn } from "../lib/utils.ts";

/** キーボードで 1 回に変える幅。Shift を押すと大きく変える。 */
const KEYBOARD_STEP = 16;
const KEYBOARD_LARGE_STEP = 64;

/**
 * ペインの境界に置く、幅を変えるハンドル。
 * 左サイドバーの右端（#185）と、右側のペインの左端（#209）で使う。
 * ドラッグの間は onResize で幅を伝え、離したとき（キーボードでは押すたび）に onCommit で確定する。
 */
export const PaneResizer = ({
  side,
  label,
  title,
  controls,
  width,
  min,
  max,
  className,
  onResize,
  onCommit,
}: {
  /**
   * 幅を変えるペインがハンドルのどちら側にあるか。
   * "left" ならハンドルを右へ動かすと広がり、"right" なら左へ動かすと広がる。
   */
  side: "left" | "right";
  label: string;
  title: string;
  /** 幅を変える要素の id。 */
  controls?: string;
  width: number;
  min: number;
  max: number;
  className?: string;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}) => {
  const drag = useRef<{ startX: number; startWidth: number; last: number }>(
    undefined,
  );
  const direction = side === "left" ? 1 : -1;
  const clamp = (next: number) =>
    Math.round(Math.min(max, Math.max(min, next)));

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    delete event.currentTarget.dataset.dragging;
    const current = drag.current;
    if (current === undefined) return;
    drag.current = undefined;
    document.body.classList.remove("select-none", "cursor-col-resize");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit(current.last);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      (event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP) * direction;
    const next =
      event.key === "ArrowLeft"
        ? width - step
        : event.key === "ArrowRight"
          ? width + step
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const clamped = clamp(next);
    onResize(clamped);
    onCommit(clamped);
  };

  return (
    <div className={cn("relative w-0 shrink-0", className)}>
      {/* biome-ignore lint/a11y/useSemanticElements: 幅を変えるハンドルは、フォーカスできる separator で表す（WAI-ARIA の Window Splitter） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-controls={controls}
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        title={title}
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none outline-none transition-colors hover:bg-ring/40 focus-visible:bg-ring/60 data-[dragging=true]:bg-ring/60"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.dataset.dragging = "true";
          drag.current = {
            startX: event.clientX,
            startWidth: width,
            last: width,
          };
          document.body.classList.add("select-none", "cursor-col-resize");
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (current === undefined) return;
          const next = clamp(
            current.startWidth + (event.clientX - current.startX) * direction,
          );
          if (next === current.last) return;
          current.last = next;
          onResize(next);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      />
    </div>
  );
};
