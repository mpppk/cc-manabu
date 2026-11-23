import { expect, test } from "bun:test";
import { MAX_IMAGE_EDGE } from "../../src/chat/attachments.ts";
import { scaledSize } from "../../src/web/lib/image.ts";

test("scaledSize は長辺を上限に収め、縦横比を保つ", () => {
  expect(scaledSize(3136, 1568)).toEqual({
    width: MAX_IMAGE_EDGE,
    height: 784,
  });
  expect(scaledSize(1000, 4000, 1000)).toEqual({ width: 250, height: 1000 });
});

test("scaledSize は小さい画像を拡大しない", () => {
  expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
});

test("scaledSize は 1px より小さくしない", () => {
  expect(scaledSize(10_000, 1, 100)).toEqual({ width: 100, height: 1 });
});
