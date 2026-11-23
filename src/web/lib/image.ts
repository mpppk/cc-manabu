import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import {
  checkImage,
  isImageMediaType,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
} from "../../chat/attachments.ts";

/** 送信前の添付画像（UIMessage の file パーツになる）。 */
export type ImageAttachment = {
  id: string;
  mediaType: string;
  filename: string;
  /** data URL。 */
  url: string;
};

export class ImageAttachError extends ErrorFactory({
  name: "ImageAttachError",
  message: (fields) => fields.reason,
  fields: ErrorFactory.fields<{ reason: string }>(),
}) {}

/** 長辺が maxEdge 以下になるように縮小したサイズ（拡大はしない）。 */
export const scaledSize = (
  width: number,
  height: number,
  maxEdge: number = MAX_IMAGE_EDGE,
): { width: number; height: number } => {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

const readAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const encode = (
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/** 縮小して描き直す。PNG・GIF は PNG に、JPEG・WebP は同じ形式にする。 */
const redraw = async (
  bitmap: ImageBitmap,
  mediaType: string,
): Promise<Blob | null> => {
  const { width, height } = scaledSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
  const lossy = mediaType === "image/jpeg" || mediaType === "image/webp";
  const blob = await encode(
    canvas,
    lossy ? mediaType : "image/png",
    lossy ? 0.9 : undefined,
  );
  // PNG のままで大きすぎるとき（写真など）は JPEG にする
  if (blob !== null && blob.size > MAX_IMAGE_BYTES && !lossy) {
    return encode(canvas, "image/jpeg", 0.85);
  }
  return blob;
};

const failure = (reason: string) =>
  Result.fail(new ImageAttachError({ reason }));

/**
 * ファイルを添付画像にする。長辺が大きすぎる・容量が大きすぎる画像は縮小する。
 */
export const toImageAttachment = async (
  file: File,
): Result.ResultAsync<ImageAttachment, ImageAttachError> => {
  if (!isImageMediaType(file.type)) {
    return failure(
      checkImage({ mediaType: file.type, bytes: file.size }) ?? "",
    );
  }
  const bitmap = await createImageBitmap(file).catch(() => undefined);
  if (bitmap === undefined) {
    return failure("画像を読み込めませんでした。");
  }
  try {
    const needsResize =
      Math.max(bitmap.width, bitmap.height) > MAX_IMAGE_EDGE ||
      file.size > MAX_IMAGE_BYTES;
    const blob = needsResize ? await redraw(bitmap, file.type) : file;
    if (blob === null) {
      return failure("画像を縮小できませんでした。");
    }
    const problem = checkImage({ mediaType: blob.type, bytes: blob.size });
    if (problem !== undefined) {
      return failure(problem);
    }
    return Result.succeed({
      id: crypto.randomUUID(),
      mediaType: blob.type,
      filename: file.name || "image",
      url: await readAsDataUrl(blob),
    });
  } catch {
    return failure("画像を読み込めませんでした。");
  } finally {
    bitmap.close();
  }
};
