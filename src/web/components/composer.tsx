import { Result } from "@praha/byethrow";
import { ArrowUp, ImagePlus, Square, X } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useRef,
  useState,
} from "react";
import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGES_PER_MESSAGE,
} from "../../chat/attachments.ts";
import { type ImageAttachment, toImageAttachment } from "../lib/image.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";

const hasFiles = (event: DragEvent) =>
  event.dataTransfer.types.includes("Files");

/** 発話の入力欄。テキストと画像（貼り付け・選択・ドロップ）を送る。 */
export const Composer = ({
  busy,
  onSubmit,
  onStop,
}: {
  busy: boolean;
  onSubmit: (text: string, images: ImageAttachment[]) => void;
  onStop: () => void;
}) => {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [loading, setLoading] = useState(0);
  const [attachError, setAttachError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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

  const canSend =
    !busy && loading === 0 && (input.trim() !== "" || images.length > 0);

  const submit = () => {
    if (!canSend) return;
    onSubmit(input.trim(), images);
    setInput("");
    setImages([]);
    setAttachError(undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
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
        "mx-auto flex max-w-3xl flex-col gap-2 rounded-xl",
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
        <ul aria-label="添付する画像" className="flex flex-wrap gap-2">
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
        <p className="text-destructive text-sm" role="alert">
          {attachError}
        </p>
      )}
      <div className="flex items-end gap-2">
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
          aria-label="画像を添付"
          title="画像を添付（貼り付け・ドロップもできます）"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus />
        </Button>
        <textarea
          className="max-h-48 min-h-11 flex-1 resize-none rounded-xl border bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="メッセージを入力（Enter で送信、Shift+Enter で改行。画像は貼り付けできます）"
          aria-label="メッセージ"
          rows={1}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {busy ? (
          <Button size="icon" aria-label="停止" onClick={onStop}>
            <Square />
          </Button>
        ) : (
          <Button
            size="icon"
            aria-label="送信"
            onClick={submit}
            disabled={!canSend}
          >
            <ArrowUp />
          </Button>
        )}
      </div>
    </section>
  );
};
