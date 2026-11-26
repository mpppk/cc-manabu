/** 右側のペイン（サイドチャット・ノートのペイン）の幅（#209）。 */

import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { MIN_MAIN_WIDTH, parseSidebarWidth } from "./sidebar-width.ts";

/** 右側のペインの最小幅（従来の lg:min-w-80）。 */
export const MIN_SIDE_PANEL_WIDTH = 320;
/** 幅を保存していないときの幅は、並べる領域の 42% を、この範囲に収めたもの（従来の lg:w-[42%] lg:max-w-xl）。 */
export const DEFAULT_SIDE_PANEL_RATIO = 0.42;
export const DEFAULT_SIDE_PANEL_MAX_WIDTH = 576;
/** メインと右側のペインを横に並べる画面幅（Tailwind の lg）。これより狭いと右側のペインを単独で表示する。 */
export const SIDE_BY_SIDE_MIN_VIEWPORT = 1024;

const STORAGE_KEY = "monet.sidePanelWidth";

/** 並べる領域の幅に対して選べる範囲。領域が狭くても、右側のペインは最小幅を保つ。 */
export const sidePanelWidthRange = (
  containerWidth: number,
): { min: number; max: number } => ({
  min: MIN_SIDE_PANEL_WIDTH,
  max: Math.max(
    MIN_SIDE_PANEL_WIDTH,
    Math.floor(containerWidth - MIN_MAIN_WIDTH),
  ),
});

export const clampSidePanelWidth = (
  width: number,
  containerWidth: number,
): number => {
  const { min, max } = sidePanelWidthRange(containerWidth);
  return Math.round(Math.min(max, Math.max(min, width)));
};

/** 表示する幅。保存していなければ既定の幅を使い、どちらも並べる領域に収める。 */
export const resolveSidePanelWidth = (
  saved: number | undefined,
  containerWidth: number,
): number =>
  clampSidePanelWidth(
    saved ??
      Math.min(
        DEFAULT_SIDE_PANEL_MAX_WIDTH,
        containerWidth * DEFAULT_SIDE_PANEL_RATIO,
      ),
    containerWidth,
  );

export const loadSidePanelWidth = (): number | undefined => {
  try {
    return parseSidebarWidth(localStorage.getItem(STORAGE_KEY));
  } catch {
    return undefined;
  }
};

export const saveSidePanelWidth = (width: number) => {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // 覚えられなくても幅は変えられる
  }
};

/** 要素の幅。大きさが変わったら測り直す。 */
export const useElementWidth = (ref: RefObject<HTMLElement | null>): number => {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
};

/**
 * 右側のペインを開いている間、メインの領域に確保してほしい幅。
 * 左サイドバーはこの幅を残して広がる（メインと右側のペインの操作に必要な幅を守る）。
 */
const reservations = new Map<symbol, number>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const reservedWidth = () => Math.max(0, ...reservations.values());

/** 開いている間、メインの領域に width を確保する。0 なら確保しない。 */
export const useReserveMainWidth = (width: number) => {
  useEffect(() => {
    if (width <= 0) return;
    const key = Symbol();
    reservations.set(key, width);
    emit();
    return () => {
      reservations.delete(key);
      emit();
    };
  }, [width]);
};

/** 右側のペインのために、メインの領域へ追加で確保する幅。 */
export const useReservedMainWidth = (): number =>
  useSyncExternalStore(subscribe, reservedWidth);

/**
 * 右側のペインの幅の状態。containerWidth はメインと右側のペインを並べる領域の幅。
 * ドラッグ中は resize、確定時は commit を呼ぶ。
 */
export const useSidePanelWidth = (containerWidth: number) => {
  const [saved, setSaved] = useState(loadSidePanelWidth);
  const width = resolveSidePanelWidth(saved, containerWidth);
  return {
    width,
    ...sidePanelWidthRange(containerWidth),
    resize: setSaved,
    commit: saveSidePanelWidth,
  };
};

/**
 * 右側のペインに付ける幅のクラスと style。メインと並べる（lg 以上の）ときだけ幅を当て、
 * 狭い画面で単独表示するときは画面幅に合わせる。
 */
export const sidePanelWidthProps = (
  width: number | undefined,
): { className: string; style?: CSSProperties } =>
  width === undefined
    ? { className: "lg:w-[42%] lg:min-w-80 lg:max-w-xl" }
    : {
        className: "lg:w-(--side-panel-width)",
        style: { "--side-panel-width": `${width}px` } as CSSProperties,
      };
