import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import {
  clampSidebarWidth,
  KEYBOARD_LARGE_STEP,
  KEYBOARD_STEP,
  sidebarWidthRange,
} from "../lib/sidebar-width.ts";

/**
 * 左サイドバーの右端に置く、幅を変えるハンドル（#185）。
 * ドラッグの間は onResize で幅を伝え、離したとき（キーボードでは押すたび）に onCommit で確定する。
 */
export const SidebarResizer = ({
  controls,
  width,
  viewportWidth,
  onResize,
  onCommit,
}: {
  /** 幅を変える要素の id。 */
  controls: string;
  width: number;
  viewportWidth: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}) => {
  const drag = useRef<{ startX: number; startWidth: number; last: number }>(
    undefined,
  );
  const { min, max } = sidebarWidthRange(viewportWidth);

  const widthAt = (clientX: number) => {
    const current = drag.current;
    return current === undefined
      ? width
      : clampSidebarWidth(
          current.startWidth + clientX - current.startX,
          viewportWidth,
        );
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
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
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
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
    const clamped = clampSidebarWidth(next, viewportWidth);
    onResize(clamped);
    onCommit(clamped);
  };

  return (
    <div className="relative w-0 shrink-0">
      {/* biome-ignore lint/a11y/useSemanticElements: 幅を変えるハンドルは、フォーカスできる separator で表す（WAI-ARIA の Window Splitter） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="サイドバーの幅"
        aria-controls={controls}
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        title="ドラッグしてサイドバーの幅を変える（←→ キーでも変えられます）"
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
          const next = widthAt(event.clientX);
          if (next === current.last) return;
          current.last = next;
          onResize(next);
        }}
        onPointerUp={(event) => {
          delete event.currentTarget.dataset.dragging;
          endDrag(event);
        }}
        onPointerCancel={(event) => {
          delete event.currentTarget.dataset.dragging;
          endDrag(event);
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
};
