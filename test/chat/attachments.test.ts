import { describe, expect, test } from "bun:test";
import {
  base64ByteLength,
  checkImage,
  checkImagePart,
  MAX_IMAGE_BYTES,
  parseDataUrl,
} from "../../src/chat/attachments.ts";

describe("parseDataUrl", () => {
  test("base64 の data URL を分解する", () => {
    expect(parseDataUrl("data:image/png;base64,iVBORw0KGgo=")).toEqual({
      mediaType: "image/png",
      base64: "iVBORw0KGgo=",
    });
  });

  test("パラメータ付きでも読める", () => {
    expect(parseDataUrl("data:image/PNG;name=a.png;base64,AAAA")).toEqual({
      mediaType: "image/png",
      base64: "AAAA",
    });
  });

  test("base64 でなければ undefined", () => {
    expect(parseDataUrl("data:text/plain,hello")).toBeUndefined();
    expect(parseDataUrl("https://example.com/a.png")).toBeUndefined();
  });
});

test("base64ByteLength はデコード後のバイト数", () => {
  for (const size of [0, 1, 2, 3, 4, 100]) {
    const base64 = Buffer.alloc(size).toString("base64");
    expect(base64ByteLength(base64)).toBe(size);
  }
});

describe("checkImage", () => {
  test("対応形式で上限以下なら問題なし", () => {
    expect(checkImage({ mediaType: "image/webp", bytes: 10 })).toBeUndefined();
    expect(
      checkImage({ mediaType: "image/jpeg", bytes: MAX_IMAGE_BYTES }),
    ).toBeUndefined();
  });

  test("対応していない形式", () => {
    expect(checkImage({ mediaType: "image/svg+xml", bytes: 10 })).toContain(
      "PNG・JPEG・GIF・WebP",
    );
  });

  test("大きすぎる", () => {
    expect(
      checkImage({ mediaType: "image/png", bytes: MAX_IMAGE_BYTES + 1 }),
    ).toContain("大きすぎます");
  });
});

describe("checkImagePart", () => {
  test("data URL と mediaType が一致していれば問題なし", () => {
    expect(
      checkImagePart({
        mediaType: "image/png",
        url: "data:image/png;base64,AAAA",
      }),
    ).toBeUndefined();
  });

  test("data URL でない・形式が食い違う", () => {
    expect(
      checkImagePart({ mediaType: "image/png", url: "https://x/a.png" }),
    ).toBeDefined();
    expect(
      checkImagePart({
        mediaType: "image/png",
        url: "data:image/jpeg;base64,AAAA",
      }),
    ).toBeDefined();
    expect(checkImagePart({ mediaType: 1, url: "x" })).toBeDefined();
  });
});
