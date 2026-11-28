import { ArrowLeftToLine, Check, ChevronDown, GitBranch } from "lucide-react";
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { MAIN_COLUMN } from "../lib/columns.ts";
import {
  MIN_SIDE_PANEL_WIDTH,
  useElementWidth,
  useReserveMainWidth,
  useSidePanelWidth,
} from "../lib/side-panel-width.ts";
import { cn } from "../lib/utils.ts";
import { PaneResizer } from "./pane-resizer.tsx";
import { Button } from "./ui/button.tsx";
import { DropdownMenu } from "./ui/dropdown-menu.tsx";

/** 狭い画面（メインとカラムを 1 列ずつ表示する、Tailwind の lg 未満）か。 */
const NARROW_QUERY = "(max-width: 1023.98px)";
const useNarrow = () => {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(NARROW_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
};

/** 右側のカラムの左端に置く、幅を変えるハンドル（#209）。狭い画面で 1 列ずつ表示するときは出さない。 */
export const SidePanelResizer = (props: {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}) => (
  <PaneResizer
    side="right"
    label="右側のペインの幅"
    title="ドラッグして右側のペインの幅を変える（←→ キーでも変えられます）"
    className="max-lg:hidden"
    {...props}
  />
);

/** 同じカラムから開いた別の経路（#254）。 */
export type ColumnPaths = {
  /** 同じカラムから開いたカラム（開いた順）。 */
  options: readonly { key: string; label: string }[];
  onSwitch: (key: string) => void;
};

/** カラムの上に出す、経路の切り替え（#254）。同じカラムから別のものを開いていると出る。 */
const PathSwitcher = ({
  paths,
  current,
}: {
  paths: ColumnPaths;
  current: string;
}) => {
  const index = paths.options.findIndex((option) => option.key === current);
  return (
    <div
      data-path-switcher
      className="flex shrink-0 items-center gap-1 border-b bg-muted/40 px-3 py-0.5 text-muted-foreground text-xs lg:border-l"
    >
      <GitBranch aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        経路 {index + 1} / {paths.options.length}
        （同じところから開いた別の経路があります）
      </span>
      <DropdownMenu
        label="別の経路に切り替える"
        icon={<ChevronDown className="size-3.5" />}
        triggerClassName="size-6"
        items={paths.options.map((option, i) => ({
          label: `${i + 1}. ${option.label}`,
          icon: option.key === current ? <Check /> : <span />,
          disabled: option.key === current,
          onSelect: () => paths.onSwitch(option.key),
        }))}
      />
    </div>
  );
};

/** 見出しを一時的に強調する（すでに開いているカラムを開き直したとき）。 */
const HIGHLIGHT_CLASS =
  "data-[highlighted]:[&>*>header]:bg-amber-500/20 data-[highlighted]:ring-2 data-[highlighted]:ring-amber-400 data-[highlighted]:ring-inset";

/**
 * メインと、その右に開くカラム（#248）。
 *
 * - 広い画面: メインと右端のカラムが画面に収まる幅にし、3 列目以降は横スクロールでたどる。
 *   右側のカラムの幅は、ハンドルで変えられる（#209。すべてのカラムで共有する）
 * - 狭い画面: 1 列ずつ画面の幅で並べ、横スワイプで移る（スクロールスナップ）
 *
 * カラムは消さずに並べるので、スクロールしても読んでいた位置・下書き・回答の生成はそのまま。
 * 別の経路（#254）のカラムも、見えないようにして描画したまま残すので、切り替えるとそのまま戻る。
 * DOM の並びは開いた順のままにし（入れ替えるとスクロール位置が失われるため）、表示の順は CSS の order で決める。
 */
export const ColumnStack = ({
  main,
  columns,
  reveal,
  highlight,
  backToMain,
  className,
  mainClassName,
  reserveMainWidth = MIN_SIDE_PANEL_WIDTH,
}: {
  /** 1 列目（メインのチャット・Wiki のノート）。 */
  main: ReactNode;
  /**
   * カラム（開いた順）。position は表示している経路での位置（0 がメインのすぐ右）で、
   * undefined なら別の経路として隠す。paths があれば、カラムの上に経路の切り替えを出す。
   */
  columns: readonly {
    key: string;
    node: ReactNode;
    position: number | undefined;
    paths?: ColumnPaths | undefined;
  }[];
  /** スクロールして見せるカラム。 */
  reveal: { key: string; nonce: number } | undefined;
  /** 見出しを強調しているカラム。 */
  highlight: string | undefined;
  /**
   * 「メインに戻る」。target（画面上部のヘッダーの操作の場所）があれば、カラムを開いている間そこに出す。
   */
  backToMain?:
    | { target: HTMLElement | null | undefined; onClick: () => void }
    | undefined;
  className?: string;
  mainClassName?: string;
  /** カラムを開いている間、左サイドバーを広げても残しておく幅。 */
  reserveMainWidth?: number;
}) => {
  const container = useRef<HTMLDivElement>(null);
  const containerWidth = useElementWidth(container);
  const sidePanel = useSidePanelWidth(containerWidth);
  const refs = useRef(new Map<string, HTMLElement>());
  const visible = new Set(
    columns
      .filter((column) => column.position !== undefined)
      .map((column) => column.key),
  );
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const open = visible.size > 0;
  /**
   * 見ているカラム（最後に開いた・選び直したカラムか、狭い画面でスワイプして移ったカラム）。
   * 狭い画面（1 列ずつの表示）で幅が変わったら、このカラムに合わせ直す。
   */
  const viewing = useRef<string>(MAIN_COLUMN);
  const revealedNonce = useRef<number | undefined>(undefined);
  if (reveal !== undefined && reveal.nonce !== revealedNonce.current) {
    revealedNonce.current = reveal.nonce;
    viewing.current = reveal.key;
  }
  const narrow = useNarrow();
  // biome-ignore lint/correctness/useExhaustiveDependencies: 幅が変わったときに合わせ直す
  useEffect(() => {
    if (!narrow) return;
    const element = refs.current.get(viewing.current);
    if (element === undefined) return;
    container.current?.scrollTo({ left: element.offsetLeft });
  }, [narrow, containerWidth]);
  const onScroll = () => {
    const box = container.current;
    if (box === null || !narrow) return;
    // 狭い画面では、左端にいちばん近いカラムを見ているものとする
    let nearest = MAIN_COLUMN;
    let distance = Number.POSITIVE_INFINITY;
    for (const [key, element] of refs.current) {
      if (key !== MAIN_COLUMN && !visibleRef.current.has(key)) continue;
      const gap = Math.abs(
        element.getBoundingClientRect().left - box.getBoundingClientRect().left,
      );
      if (gap < distance) {
        nearest = key;
        distance = gap;
      }
    }
    viewing.current = nearest;
  };
  useReserveMainWidth(open ? reserveMainWidth : 0);

  // 開いた・選び直したカラムまでスクロールする
  useEffect(() => {
    if (reveal === undefined) return;
    const frame = requestAnimationFrame(() => {
      const element = refs.current.get(reveal.key);
      if (element === undefined) return;
      if (reveal.key === MAIN_COLUMN) {
        container.current?.scrollTo({ left: 0, behavior: "smooth" });
      } else {
        element.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "nearest",
        });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal]);

  const register = (key: string) => (element: HTMLElement | null) => {
    if (element === null) refs.current.delete(key);
    else refs.current.set(key, element);
  };
  const style = {
    "--main-column-width": `${Math.max(0, containerWidth - sidePanel.width)}px`,
    "--side-column-width": `${sidePanel.width}px`,
  } as CSSProperties;

  return (
    <div
      ref={container}
      data-column-stack
      onScroll={onScroll}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain max-lg:snap-x max-lg:snap-mandatory",
        className,
      )}
      style={style}
    >
      <div
        ref={register(MAIN_COLUMN)}
        data-column={MAIN_COLUMN}
        data-highlighted={highlight === MAIN_COLUMN ? "" : undefined}
        className={cn(
          "flex min-h-0 min-w-0 flex-col max-lg:w-full max-lg:shrink-0 max-lg:snap-start",
          open ? "lg:w-(--main-column-width) lg:shrink-0" : "flex-1",
          HIGHLIGHT_CLASS,
          mainClassName,
        )}
      >
        {main}
      </div>
      {columns.map((column) => {
        const shown = column.position !== undefined;
        const order = (column.position ?? 0) * 2;
        return (
          <Fragment key={column.key}>
            {shown && (
              <div className="flex w-0 shrink-0" style={{ order: order + 1 }}>
                <SidePanelResizer
                  width={sidePanel.width}
                  min={sidePanel.min}
                  max={sidePanel.max}
                  onResize={sidePanel.resize}
                  onCommit={sidePanel.commit}
                />
              </div>
            )}
            <div
              ref={register(column.key)}
              data-column={shown ? column.key : undefined}
              data-hidden-column={shown ? undefined : column.key}
              data-highlighted={highlight === column.key ? "" : undefined}
              aria-hidden={shown ? undefined : true}
              inert={!shown}
              className={cn(
                "flex min-h-0 min-w-0 shrink-0 flex-col bg-background max-lg:w-full lg:w-(--side-column-width)",
                shown
                  ? "max-lg:snap-start"
                  : // 別の経路: 場所を取らずに見えなくする（描画は残し、スクロール位置を保つ）
                    "pointer-events-none invisible absolute inset-y-0 left-0",
                HIGHLIGHT_CLASS,
              )}
              style={shown ? { order: order + 2 } : undefined}
            >
              {shown && column.paths !== undefined && (
                <PathSwitcher paths={column.paths} current={column.key} />
              )}
              {column.node}
            </div>
          </Fragment>
        );
      })}
      {open &&
        backToMain?.target != null &&
        createPortal(
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5 px-2"
            title="1 列目（メイン）までスクロールします"
            onClick={backToMain.onClick}
          >
            <ArrowLeftToLine className="size-4 text-muted-foreground" />
            <span className="hidden sm:inline">メインに戻る</span>
            <span className="sr-only sm:hidden">メインに戻る</span>
          </Button>,
          backToMain.target,
        )}
    </div>
  );
};
