/**
 * 発話に添付する画像の決まりごと。サーバ（入力の検証）と Web UI（添付時の確認）で共有する。
 */

/** 添付できる画像の形式（Claude が受け付ける形式）。 */
export const IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** 1 枚の上限（デコード後のバイト数）。Claude API の上限に合わせる。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 1 発話に添付できる枚数。 */
export const MAX_IMAGES_PER_MESSAGE = 10;

/** これより長い辺はブラウザで縮小する（Claude 側でもこの程度に縮小される）。 */
export const MAX_IMAGE_EDGE = 1568;

export const isImageMediaType = (value: string): value is ImageMediaType =>
  (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);

/** `data:<mediaType>;base64,<data>` を分解する。base64 でなければ undefined。 */
export const parseDataUrl = (
  url: string,
): { mediaType: string; base64: string } | undefined => {
  const match = /^data:([^;,]+)(?:;[^;,]+)*;base64,(.*)$/s.exec(url);
  if (match === null) {
    return undefined;
  }
  const [, mediaType = "", base64 = ""] = match;
  return { mediaType: mediaType.toLowerCase(), base64 };
};

/** base64 をデコードしたときのバイト数。 */
export const base64ByteLength = (base64: string): number => {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
};

/** 添付画像の問題を日本語で返す。問題なければ undefined。 */
export const checkImage = (image: {
  mediaType: string;
  bytes: number;
}): string | undefined => {
  if (!isImageMediaType(image.mediaType)) {
    return "PNG・JPEG・GIF・WebP の画像だけ添付できます。";
  }
  if (image.bytes > MAX_IMAGE_BYTES) {
    return `画像が大きすぎます（1 枚 ${MAX_IMAGE_BYTES / 1024 / 1024}MB まで）。`;
  }
  return undefined;
};

/** UIMessage の file パーツ（画像の data URL）を検証する。問題なければ undefined。 */
export const checkImagePart = (part: {
  mediaType: unknown;
  url: unknown;
}): string | undefined => {
  if (typeof part.mediaType !== "string" || typeof part.url !== "string") {
    return "画像の形式が正しくありません。";
  }
  const parsed = parseDataUrl(part.url);
  if (parsed === undefined || parsed.mediaType !== part.mediaType) {
    return "画像の形式が正しくありません。";
  }
  return checkImage({
    mediaType: parsed.mediaType,
    bytes: base64ByteLength(parsed.base64),
  });
};
