import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createRouterClient } from "@orpc/server";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
} from "../../src/chat/attachments.ts";
import { router } from "../../src/router.ts";
import { createTestContext } from "../helpers/context.ts";
import { createFakeQuery, loadFixture } from "../provider/fake-query.ts";

const PNG = Buffer.from(
  await Bun.file(
    path.join(import.meta.dir, "..", "fixtures", "images", "red-7.png"),
  ).arrayBuffer(),
).toString("base64");

const imagePart = (
  base64: string = PNG,
  mediaType = "image/png",
  urlType = mediaType,
) => ({
  type: "file" as const,
  mediaType,
  filename: "screenshot.png",
  url: `data:${urlType};base64,${base64}`,
});

const drain = async (iterable: AsyncIterable<unknown>) => {
  for await (const _ of iterable) {
    // 読み切る
  }
};

/** query() に渡った prompt から、ユーザーメッセージの content を取り出す。 */
const contentOf = async (prompt: unknown) => {
  if (typeof prompt === "string") {
    return prompt;
  }
  const contents: unknown[] = [];
  for await (const message of prompt as AsyncIterable<{
    message: { content: unknown };
  }>) {
    contents.push(message.message.content);
  }
  return contents;
};

const setup = async () => {
  const fake = createFakeQuery(await loadFixture("text-partial"));
  const ctx = createTestContext({ query: fake.query });
  const client = createRouterClient(router, { context: ctx.context });
  const chat = await client.chats.create({});
  return { ...ctx, ...fake, client, chat };
};

const imageBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: PNG },
};

describe("画像付きの発話", () => {
  test("画像とテキストを Claude Code に渡し、画像ごと保存する", async () => {
    const { client, chat, calls } = await setup();
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: {
          id: "u1",
          role: "user",
          parts: [imagePart(), { type: "text", text: "これは何？" }],
        },
      }),
    );
    expect(await contentOf(calls[0]?.prompt)).toEqual([
      [imageBlock, { type: "text", text: "これは何？" }],
    ]);
    const { chat: saved, messages } = await client.chats.get({ id: chat.id });
    expect(saved.title).toBe("これは何？");
    expect(messages[0]?.parts).toEqual([
      imagePart(),
      { type: "text", text: "これは何？" },
    ]);
  });

  test("画像だけでも送れて、タイトルは「画像」", async () => {
    const { client, chat, calls } = await setup();
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: { id: "u1", role: "user", parts: [imagePart()] },
      }),
    );
    expect(await contentOf(calls[0]?.prompt)).toEqual([[imageBlock]]);
    expect((await client.chats.get({ id: chat.id })).chat.title).toBe("画像");
  });

  test("再生成でも画像を送り直す", async () => {
    const { client, chat, calls } = await setup();
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: {
          id: "u1",
          role: "user",
          parts: [imagePart(), { type: "text", text: "説明して" }],
        },
      }),
    );
    await drain(await client.chat.regenerate({ chatId: chat.id }));
    expect(await contentOf(calls[1]?.prompt)).toEqual([
      [imageBlock, { type: "text", text: "説明して" }],
    ]);
  });

  test("編集では本文だけを書き換え、画像はそのまま送る", async () => {
    const { client, chat, calls } = await setup();
    await drain(
      await client.chat.send({
        chatId: chat.id,
        message: {
          id: "u1",
          role: "user",
          parts: [imagePart(), { type: "text", text: "説明して" }],
        },
      }),
    );
    await drain(
      await client.chat.edit({
        chatId: chat.id,
        messageId: "u1",
        text: "英語で説明して",
      }),
    );
    expect(await contentOf(calls[1]?.prompt)).toEqual([
      [imageBlock, { type: "text", text: "英語で説明して" }],
    ]);
    const { messages } = await client.chats.get({ id: chat.id });
    expect(messages[0]?.parts).toEqual([
      imagePart(),
      { type: "text", text: "英語で説明して" },
    ]);
  });

  test.each([
    [
      "対応していない形式",
      [imagePart(PNG, "image/svg+xml")],
      "PNG・JPEG・GIF・WebP",
    ],
    [
      "data URL と形式が食い違う",
      [imagePart(PNG, "image/png", "image/jpeg")],
      "画像の形式",
    ],
    [
      "大きすぎる",
      [imagePart(Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64"))],
      "大きすぎます",
    ],
    [
      "枚数が多すぎる",
      Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => imagePart()),
      `${MAX_IMAGES_PER_MESSAGE} 枚まで`,
    ],
  ])("%s は BAD_REQUEST", async (_, parts, message) => {
    const { client, chat, calls } = await setup();
    const error = await client.chat
      .send({
        chatId: chat.id,
        message: { id: "u1", role: "user", parts },
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toMatchObject({ code: "BAD_REQUEST" });
    expect(JSON.stringify((error as { data?: unknown }).data)).toContain(
      message,
    );
    expect(calls).toHaveLength(0);
  });
});
