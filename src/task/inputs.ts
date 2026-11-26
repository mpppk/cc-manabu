/**
 * タスクの名前・進捗・関連リンクの入力検証。タスクの設定画面（oRPC）と、
 * Claude がタスクを更新するツール（#187）で同じものを使う。
 */
import * as z from "zod";
import { TASK_STATUSES } from "../db/schema.ts";

export const taskName = z.string().trim().min(1).max(100);

/** 進捗の項目。指定した項目だけを変える。 */
export const taskProgressFields = {
  status: z.enum(TASK_STATUSES).optional(),
  progressNote: z.string().max(20_000).optional(),
  /** ゴール（達成の条件）。Claude Code の `/goal` の条件の上限にそろえる（#198）。 */
  nextAction: z.string().trim().max(4000).optional(),
};

/** 関連リンクの入力。URL は http / https だけ。表示名は空なら null（URL を表示する）。 */
export const taskLinkInput = z.object({
  url: z
    .string()
    .trim()
    .max(2000)
    .url()
    .refine(
      (url) => URL.canParse(url) && /^https?:$/.test(new URL(url).protocol),
      "http または https の URL を入力してください。",
    ),
  label: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((label) => (label === "" || label === undefined ? null : label)),
});
