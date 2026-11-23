import { useState } from "react";
import type { ChatUIMessage } from "../../chat/chat-service.ts";
import { Dialog } from "./ui/dialog.tsx";

type FilePart = Extract<ChatUIMessage["parts"][number], { type: "file" }>;

export const imagePartsOf = (message: ChatUIMessage): FilePart[] =>
  message.parts.filter(
    (part): part is FilePart =>
      part.type === "file" && part.mediaType.startsWith("image/"),
  );

/** 発話に添付した画像。クリックで拡大する。 */
export const MessageImages = ({ images }: { images: FilePart[] }) => {
  const [open, setOpen] = useState<FilePart>();
  if (images.length === 0) {
    return null;
  }
  return (
    <>
      <div className="flex flex-wrap justify-end gap-2">
        {images.map((image, i) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: パーツの順番は変わらない
            key={i}
            type="button"
            aria-label={`画像を拡大（${image.filename ?? "画像"}）`}
            className="overflow-hidden rounded-lg border"
            onClick={() => setOpen(image)}
          >
            <img
              src={image.url}
              alt={image.filename ?? "添付した画像"}
              className="max-h-48 max-w-64 object-contain"
            />
          </button>
        ))}
      </div>
      <Dialog
        open={open !== undefined}
        onOpenChange={(next) => {
          if (!next) setOpen(undefined);
        }}
        title={open?.filename ?? "画像"}
        className="max-w-[90vw]"
      >
        {open !== undefined && (
          <img
            src={open.url}
            alt={open.filename ?? "添付した画像"}
            className="max-h-[80vh] w-auto justify-self-center object-contain"
          />
        )}
      </Dialog>
    </>
  );
};
