import { Result } from "@praha/byethrow";
import {
  ArrowUp,
  ChevronUp,
  GitBranch,
  ImagePlus,
  ListPlus,
  Square,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGES_PER_MESSAGE,
} from "../../chat/attachments.ts";
import { type ImageAttachment, toImageAttachment } from "../lib/image.ts";
import { hasShortcutModifier, MODIFIER_LABEL } from "../lib/shortcut.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { DropdownMenu } from "./ui/dropdown-menu.tsx";

const hasFiles = (event: DragEvent) =>
  event.dataTransfer.types.includes("Files");

/** 現在地（HEAD）を維持したまま、そこから分岐した新しい会話に送る操作（#225）。 */
export type BranchSend = {
  /** 送れないときの理由。あれば送らずに理由を出す。 */
  blocker?: string | undefined;
  onSubmit: (
    text: string,
    images: ImageAttachment[],
  ) => undefined | Promise<boolean>;
};

/** 「現在地を維持して送信」のショートカットの表示。 */
export const BRANCH_SEND_SHORTCUT = `${MODIFIER_LABEL}Enter`;

/**
 * 発話の入力欄。テキストと画像（貼り付け・選択・ドロップ）を送る。
 * 生成中は、送る代わりに予約できる（#102）。branchSend があれば、⌘Enter（Ctrl+Enter）と
 * 送信ボタン横のメニューから、現在地を維持して分岐に送れる（#225）。
 */
export const Composer = ({
  busy,
  pending = false,
  messageLabel = "メッセージ",
  queueing = false,
  toolbar,
  onSubmit,
  onQueue,
  onStop,
  branchSend,
}: {
  busy: boolean;
  pending?: boolean;
  messageLabel?: string;
  /** 送る代わりに予約するか（生成中・送信待ちの予約があるとき）。 */
  queueing?: boolean;
  /** 入力欄の下の行（添付ボタンの右）に出すもの。モデル・effort の選択など。 */
  toolbar?: ReactNode;
  onSubmit: (
    text: string,
    images: ImageAttachment[],
  ) => undefined | Promise<boolean>;
  onQueue?: (text: string, images: ImageAttachment[]) => void;
  onStop?: () => void;
  branchSend?: BranchSend | undefined;
}) => {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [loading, setLoading] = useState(0);
  const [attachError, setAttachError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  /** 現在地を維持して送れなかった理由（ショートカットを押したとき）。 */
  const [branchNotice, setBranchNotice] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setAttachError(undefined);
    const room = MAX_IMAGES_PER_MESSAGE - images.length - loading;
    if (files.length > room) {
      setAttachError(
        `画像は 1 つの発話に ${MAX_IMAGES_PER_MESSAGE} 枚まで添付できます。`,
      );
    }
    const accepted = files.slice(0, Math.max(0, room));
    setLoading((n) => n + accepted.length);
    for (const file of accepted) {
      const result = await toImageAttachment(file);
      setLoading((n) => n - 1);
      if (Result.isSuccess(result)) {
        setImages((current) => [...current, result.value]);
      } else {
        setAttachError(result.error.message);
      }
    }
  };

  const queue = queueing && onQueue !== undefined;
  const hasContent =
    !pending && loading === 0 && (input.trim() !== "" || images.length > 0);
  const canSend = hasContent && (!busy || queue);

  const clear = () => {
    setInput("");
    setImages([]);
    setAttachError(undefined);
    setBranchNotice(undefined);
  };

  const submit = async () => {
    if (!canSend) return;
    if (queue) {
      onQueue(input.trim(), images);
    } else {
      const sent = onSubmit(input.trim(), images);
      if (sent !== undefined && !(await sent)) return;
    }
    clear();
  };

  /** 現在地を維持して、分岐に送る。送れなければ、通常の送信や予約にはせずに理由を出す。 */
  const submitToBranch = async () => {
    if (branchSend === undefined) return;
    if (branchSend.blocker !== undefined) {
      setBranchNotice(branchSend.blocker);
      return;
    }
    if (!hasContent) {
      setBranchNotice("送るメッセージを入力してください。");
      return;
    }
    const sent = branchSend.onSubmit(input.trim(), images);
    if (sent !== undefined && !(await sent)) return;
    clear();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    // ⌘ / Ctrl を押した Enter は、通常の送信・予約にしない（誤送信を防ぐ）
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      if (branchSend !== undefined && hasShortcutModifier(event)) {
        void submitToBranch();
      }
      return;
    }
    if (!event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    // 画像だけのクリップボード（スクリーンショットなど）では、ファイル名などの文字を貼らない
    if (event.clipboardData.getData("text/plain") === "") {
      event.preventDefault();
    }
    void addFiles(files);
  };

  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    void addFiles([...event.dataTransfer.files]);
  };

  return (
    <section
      aria-label="入力欄"
      className={cn(
        "mx-auto flex max-w-3xl flex-col gap-2 rounded-2xl border bg-background p-2 shadow-sm transition-colors focus-within:border-ring/60",
        dragging && "outline-2 outline-ring outline-dashed outline-offset-4",
      )}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {(images.length > 0 || loading > 0) && (
        <ul
          aria-label="添付する画像"
          className="flex flex-wrap gap-2 px-1 pt-1"
        >
          {images.map((image) => (
            <li key={image.id} className="relative">
              <img
                src={image.url}
                alt={image.filename}
                className="size-16 rounded-md border object-cover"
              />
              <button
                type="button"
                aria-label={`画像を削除（${image.filename}）`}
                className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow"
                onClick={() =>
                  setImages((current) =>
                    current.filter((i) => i.id !== image.id),
                  )
                }
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
          {loading > 0 && (
            <li className="flex size-16 items-center justify-center rounded-md border text-muted-foreground text-xs">
              読み込み中
            </li>
          )}
        </ul>
      )}
      {attachError !== undefined && (
        <p className="px-1 text-destructive text-sm" role="alert">
          {attachError}
        </p>
      )}
      {branchNotice !== undefined && (
        <p className="px-1 text-muted-foreground text-sm" role="status">
          現在地を維持して送信できません: {branchNotice}
        </p>
      )}
      {/* キー操作の説明。プレースホルダーは狭い画面でも 1 行に収まるよう短くし、説明はここに置く（#260） */}
      <span id={hintId} className="sr-only">
        {queue
          ? "Enter で予約、Shift+Enter で改行。今の回答が終わったあとに順に送ります。"
          : "Enter で送信、Shift+Enter で改行。"}
        {branchSend === undefined
          ? ""
          : `${BRANCH_SEND_SHORTCUT} で現在地を維持して送信。`}
        画像は貼り付け・ドロップ・添付ボタンで追加できます。
      </span>
      <textarea
        ref={textarea}
        className="max-h-48 min-h-10 w-full resize-none bg-transparent px-2 py-1.5 outline-none"
        placeholder={queue ? "メッセージを予約" : "メッセージを入力"}
        aria-label={messageLabel}
        aria-describedby={hintId}
        rows={1}
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          setBranchNotice(undefined);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="flex items-center gap-1">
        <input
          ref={fileInput}
          type="file"
          accept={IMAGE_MEDIA_TYPES.join(",")}
          multiple
          hidden
          data-testid="image-input"
          onChange={(event) => {
            void addFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label="画像を添付"
          title="画像を添付（貼り付け・ドロップもできます）"
          disabled={busy && !queue}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-1">{toolbar}</div>
        {queue && (
          <Button
            size="icon"
            variant={busy ? "outline" : "default"}
            className="size-8 rounded-full"
            aria-label="送信を予約"
            title="送信を予約（Enter。Shift+Enter で改行）。今の回答が終わったあとに順に送ります"
            onClick={submit}
            disabled={!canSend}
          >
            <ListPlus />
          </Button>
        )}
        {busy ? (
          <Button
            size="icon"
            className="size-8 rounded-full"
            aria-label="停止"
            onClick={onStop}
          >
            <Square className="fill-current" />
          </Button>
        ) : queue ? null : (
          <Button
            size="icon"
            className="size-8 rounded-full"
            aria-label="送信"
            title="送信（Enter。Shift+Enter で改行）"
            onClick={submit}
            disabled={!canSend}
          >
            <ArrowUp />
          </Button>
        )}
        {branchSend !== undefined && (
          <DropdownMenu
            label="送信のメニュー"
            icon={<ChevronUp />}
            triggerClassName="size-8 text-muted-foreground"
            placement="above"
            items={[
              {
                label: "現在地を維持して送信",
                icon: <GitBranch />,
                shortcut: BRANCH_SEND_SHORTCUT,
                disabled: branchSend.blocker !== undefined || !hasContent,
                title:
                  branchSend.blocker ??
                  (hasContent
                    ? "今の現在地から分岐した新しい会話に送り、回答をサイドチャットに出します。メインの会話と現在地はそのまま"
                    : "送るメッセージを入力してください"),
                onSelect: () => {
                  void submitToBranch();
                  textarea.current?.focus();
                },
              },
            ]}
          />
        )}
      </div>
    </section>
  );
};
