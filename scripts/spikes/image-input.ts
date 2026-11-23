#!/usr/bin/env bun
/**
 * Spike: Agent SDK の query() に画像を渡せるかを確認する。
 * prompt に AsyncIterable<SDKUserMessage> を渡し、content に image ブロックを入れる。
 * 1. 新しいセッションの最初の発話に画像を付ける
 * 2. resume したセッションに画像を付ける
 * 3. 画像なしで resume し、前の画像を覚えているか
 * 実機の claude を使う（サブスクの利用枠を少し消費する）。
 *
 *   bun scripts/spikes/image-input.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Options,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { chromium } from "playwright";

/** 背景色と文字だけの画像を PNG で作る。 */
const renderImage = async (text: string, color: string): Promise<string> => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 200, height: 120 },
    });
    await page.setContent(
      `<body style="margin:0;background:${color};display:flex;align-items:center;justify-content:center;height:120px;font:bold 64px sans-serif;color:white">${text}</body>`,
    );
    return (await page.screenshot({ type: "png" })).toString("base64");
  } finally {
    await browser.close();
  }
};

const userMessage = (
  text: string,
  image?: { data: string; mediaType: "image/png" },
): SDKUserMessage => ({
  type: "user",
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [
      ...(image === undefined
        ? []
        : [
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: image.mediaType,
                data: image.data,
              },
            },
          ]),
      { type: "text" as const, text },
    ],
  },
});

const run = async (message: SDKUserMessage, options: Options) => {
  let sessionId = "";
  let text = "";
  let error: string | undefined;
  async function* prompt() {
    yield message;
  }
  try {
    for await (const m of query({ prompt: prompt(), options })) {
      if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
      if (m.type === "assistant") {
        for (const block of m.message.content) {
          if (block.type === "text") text += block.text;
        }
      }
      if (m.type === "result" && m.subtype !== "success") {
        error = m.subtype;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { sessionId, text, error };
};

const cwd = await mkdtemp(path.join(tmpdir(), "spike-image-"));
const base: Options = {
  cwd,
  model: "haiku",
  settingSources: [],
  allowedTools: [],
  thinking: { type: "disabled" },
};
try {
  const red = await renderImage("7", "#d00");
  const blue = await renderImage("K", "#00d");

  const first = await run(
    userMessage("この画像の背景色と、書かれている文字を短く答えて。", {
      data: red,
      mediaType: "image/png",
    }),
    base,
  );
  console.log("1. 初回 + 画像:", first);

  const second = await run(
    userMessage("この画像の背景色と、書かれている文字を短く答えて。", {
      data: blue,
      mediaType: "image/png",
    }),
    { ...base, resume: first.sessionId },
  );
  console.log("2. resume + 画像:", second);

  const third = await run(
    userMessage("最初に見せた画像の文字は何でしたか？一言で。"),
    { ...base, resume: first.sessionId },
  );
  console.log("3. resume（画像なし）:", third);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
