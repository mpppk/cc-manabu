import { Boxes, Folder } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { EnvironmentDto } from "../../router.ts";

/**
 * 入力欄の下に出す、スレッドが属するタスクの環境名（#192）。
 * 押すと環境の名前・説明・参照する Wiki・ディレクトリをポップオーバーで出す。会話はそのまま続けられる。
 */
export const EnvironmentPopover = ({
  environment,
  cwd,
}: {
  environment: Pick<
    EnvironmentDto,
    "id" | "name" | "description" | "wikiName" | "directories"
  >;
  /** このスレッドの作業ディレクトリ。 */
  cwd: string;
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [defaultDirectory] = environment.directories;
  const differentCwd = cwd !== "" && cwd !== defaultDirectory;

  // 別の環境のスレッドに切り替えたら閉じる
  // biome-ignore lint/correctness/useExhaustiveDependencies: 環境が変わったときだけ閉じる
  useEffect(() => setOpen(false), [environment.id]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        className="flex min-w-0 max-w-full items-center gap-1 rounded-sm text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`環境: ${environment.name}（詳細を開く）`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={`環境: ${environment.name}`}
        onClick={() => setOpen((prev) => !prev)}
      >
        <Boxes className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{environment.name}</span>
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={`環境「${environment.name}」の詳細`}
          tabIndex={-1}
          className="absolute bottom-full left-0 z-40 mb-2 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-md border bg-background p-3 text-sm shadow-md outline-none"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="flex items-center gap-2">
            <Boxes
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <p className="min-w-0 break-words font-medium">
              {environment.name}
            </p>
          </div>
          <dl className="flex flex-col gap-2 text-xs">
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground">説明</dt>
              <dd className="whitespace-pre-wrap break-words">
                {environment.description.trim() === ""
                  ? "（なし）"
                  : environment.description}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground">参照する Wiki</dt>
              <dd className="break-words">
                {environment.wikiName ?? "（使わない）"}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground">ディレクトリ</dt>
              <dd>
                {defaultDirectory === undefined ? (
                  "（なし）"
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {environment.directories.map((directory, index) => (
                      <li
                        key={directory}
                        className="flex min-w-0 items-start gap-1"
                        title={directory}
                      >
                        <Folder
                          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <span className="min-w-0 break-all">
                          {directory}
                          <span className="text-muted-foreground">
                            {index === 0
                              ? "（既定の作業ディレクトリ）"
                              : "（追加）"}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            {differentCwd && (
              <div className="flex flex-col gap-0.5">
                <dt className="text-muted-foreground">
                  このスレッドの作業ディレクトリ
                </dt>
                <dd className="flex min-w-0 items-start gap-1" title={cwd}>
                  <Folder
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 break-all">{cwd}</span>
                </dd>
              </div>
            )}
          </dl>
          <button
            type="button"
            className="self-end rounded-sm px-2 py-1 text-muted-foreground text-xs hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={close}
          >
            閉じる
          </button>
        </div>
      )}
    </div>
  );
};
