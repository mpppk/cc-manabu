import { existsSync } from "node:fs";
import {
  getSessionInfo,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

/**
 * ローカルの Claude Code セッションの 1 件の記録（getSessionMessages の SessionMessage のうち、使う部分）。
 */
export type TranscriptEntry = {
  type: "user" | "assistant" | "system";
  uuid: string;
  message: unknown;
  /** 表示しないメッセージ（スラッシュコマンドの展開など）。 */
  is_meta?: boolean;
};

/**
 * ローカルの Claude Code セッションの読み取り（#244）。読むだけで、セッションには書き込まない。
 * dir は会話の作業ディレクトリ（セッションのファイルを探すプロジェクト）。
 */
export type SessionReader = {
  /** 最終更新日時（ミリ秒）。セッションが無ければ undefined。 */
  lastModified: (sessionId: string, dir: string) => Promise<number | undefined>;
  /** 会話の記録（古い順）。 */
  messages: (sessionId: string, dir: string) => Promise<TranscriptEntry[]>;
};

/** Agent SDK の getSessionInfo / getSessionMessages で読む。 */
export const sdkSessionReader: SessionReader = {
  lastModified: async (sessionId, dir) =>
    (await getSessionInfo(sessionId, { dir }))?.lastModified,
  messages: async (sessionId, dir) =>
    (await getSessionMessages(sessionId, { dir })) as TranscriptEntry[],
};

/** Monet に保存した会話のメッセージのうち、照合に使う部分。 */
export type SavedMessage = {
  role: "user" | "assistant" | "system";
  /** 回答の最後の SDK のメッセージの uuid（回答だけ）。 */
  sdkUuid: string | null;
};

/** 利用者の質問ではない、Claude Code が書き足す user のメッセージ。 */
const NOT_A_PROMPT =
  /^\s*(?:<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder)>|\[Request interrupted by user)/;

type ContentBlock = { type?: unknown; text?: unknown };

/**
 * 利用者の質問か。ツールの結果・表示しないメッセージ・中断の印・スラッシュコマンドの出力は除く。
 */
export const isPrompt = (entry: TranscriptEntry): boolean => {
  if (entry.type !== "user" || entry.is_meta === true) return false;
  const content = (entry.message as { content?: unknown } | null)?.content;
  if (typeof content === "string") {
    return content.trim() !== "" && !NOT_A_PROMPT.test(content);
  }
  if (!Array.isArray(content)) return false;
  const blocks = content.filter(
    (block): block is ContentBlock =>
      typeof block === "object" && block !== null,
  );
  if (blocks.some((block) => block.type === "tool_result")) return false;
  const text = blocks.find(
    (block) => block.type === "text" && typeof block.text === "string",
  )?.text as string | undefined;
  if (text !== undefined && text.trim() !== "") {
    return !NOT_A_PROMPT.test(text);
  }
  return blocks.some((block) => block.type === "image");
};

/**
 * Claude Code のセッションに、Monet に保存していない質問がいくつあるか（#244）。
 *
 * Monet は回答ごとに、その回答の最後の SDK メッセージの uuid（sdkUuid）を保存している。
 * セッションの記録の中でそれらの位置を探し、区切られた区間ごとに、セッション側の質問の数と
 * Monet の質問の数を比べる。セッション側のほうが多い分を、Monet の外（Claude Desktop や CLI）で
 * 足された質問とみなす。タイトルの変更など、質問が増えていない更新は数えない。
 * Monet の回答を 1 つもセッションの中に見つけられなければ照合できないので undefined。
 */
export const countUnimportedPrompts = (
  saved: readonly SavedMessage[],
  transcript: readonly TranscriptEntry[],
): number | undefined => {
  const positions = new Map(
    transcript.map((entry, index) => [entry.uuid, index]),
  );
  /** Monet の回答と、そのセッションの中での位置（見つかったものだけ、両方で順序が合うもの）。 */
  const anchors: { saved: number; transcript: number }[] = [];
  saved.forEach((message, index) => {
    if (message.role !== "assistant" || message.sdkUuid === null) return;
    const position = positions.get(message.sdkUuid);
    const last = anchors.at(-1);
    if (position === undefined || (last && position <= last.transcript)) {
      return;
    }
    anchors.push({ saved: index, transcript: position });
  });
  if (anchors.length === 0) return undefined;
  const countSaved = (from: number, to: number) =>
    saved.slice(from, to).filter((message) => message.role === "user").length;
  const countTranscript = (from: number, to: number) =>
    transcript.slice(from, to).filter(isPrompt).length;
  let unimported = 0;
  anchors.forEach((anchor, i) => {
    const next = anchors[i + 1];
    const extra =
      countTranscript(
        anchor.transcript + 1,
        next?.transcript ?? transcript.length,
      ) - countSaved(anchor.saved + 1, next?.saved ?? saved.length);
    if (extra > 0) unimported += extra;
  });
  return unimported;
};

export class DesktopLaunchError extends ErrorFactory({
  name: "DesktopLaunchError",
  message: (fields) => `Claude Desktop で開けませんでした: ${fields.reason}`,
  fields: ErrorFactory.fields<{ reason: string }>(),
}) {}

/** 会話のセッションを Claude Desktop で開く（`claude --desktop --resume <id>`）。 */
export type DesktopLauncher = (input: {
  sessionId: string;
  cwd: string;
}) => Promise<Result.Result<void, DesktopLaunchError>>;

/** 終わるのを待つ時間。これを過ぎても動いていれば、起動できたものとして待つのをやめる。 */
const LAUNCH_WAIT_MS = 15_000;

/** 出力の最後の数行（エラーの理由に出す）。 */
const tail = (text: string): string =>
  text.trim().split("\n").slice(-3).join(" ").slice(0, 300);

/**
 * claudePath の `claude --desktop --resume <id>` を会話の作業ディレクトリで実行する。
 * 失敗したら（見つからない・対応していない・Desktop が無いなど）、出力から理由を返す。
 */
export const createDesktopLauncher =
  (claudePath: string | undefined): DesktopLauncher =>
  async ({ sessionId, cwd }) => {
    if (claudePath === undefined) {
      return Result.fail(
        new DesktopLaunchError({
          reason: "Claude Code（claude コマンド）が見つかりません。",
        }),
      );
    }
    if (!existsSync(cwd)) {
      return Result.fail(
        new DesktopLaunchError({
          reason: `作業ディレクトリが見つかりません（${cwd}）。`,
        }),
      );
    }
    const spawned = Result.try({
      try: () =>
        Bun.spawn([claudePath, "--desktop", "--resume", sessionId], {
          cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: (cause) =>
        new DesktopLaunchError({
          reason: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
    if (Result.isFailure(spawned)) return spawned;
    const proc = spawned.value;
    const timer = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), LAUNCH_WAIT_MS),
    );
    const exited = await Promise.race([proc.exited, timer]);
    if (exited === "timeout") {
      proc.unref();
      return Result.succeed(undefined);
    }
    if (exited === 0) return Result.succeed(undefined);
    const [stderr, stdout] = await Promise.all([
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);
    return Result.fail(
      new DesktopLaunchError({
        reason:
          tail(stderr) ||
          tail(stdout) ||
          `claude が終了コード ${exited} で終了しました。Claude Desktop と、それに対応する Claude Code が入っているか確かめてください。`,
      }),
    );
  };
