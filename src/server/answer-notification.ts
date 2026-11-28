/**
 * 回答が完了したら、Monet のサーバーを動かしている Mac に通知する（#264）。
 *
 * サーバー側で、正常に終わって保存した回答ごとに 1 回だけ通知する。ブラウザのタブの数や再接続に
 * よらず重複せず、ウィンドウを閉じていてもサーバーが動いていれば届く。停止・エラーでは
 * 回答の完了として扱わず（ChatService の onAnswerFinish が呼ばれない）、承認待ちは生成が
 * 終わっていないので通知しない。
 */
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import type { ChatRepository } from "../db/chat-repository.ts";

export class NotificationError extends ErrorFactory({
  name: "NotificationError",
  message: ({ detail }) => detail,
  fields: ErrorFactory.fields<{ detail: string }>(),
}) {}

/** 通知の見出し。 */
export const ANSWER_NOTIFICATION_TITLE = "Monet · 回答が完了しました";
/** スレッドにまだタイトルが無いときの名前（サイドバーの表示と合わせる）。 */
const UNTITLED = "新しいスレッド";

/** 通知を出す。title は見出し、message は本文。 */
export type Notify = (
  title: string,
  message: string,
) => Result.ResultAsync<void, NotificationError>;

/**
 * AppleScript を引数で受け取って通知する。本文を AppleScript の文字列に埋め込まないので、
 * スレッド名に引用符などが入っていても壊れない。
 */
const NOTIFY_SCRIPT = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run",
];

/** macOS の通知センターに出す（osascript の display notification）。 */
export const notifyWithOsascript: Notify = async (title, message) => {
  try {
    const child = Bun.spawn(
      [
        "osascript",
        ...NOTIFY_SCRIPT.flatMap((line) => ["-e", line]),
        title,
        message,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill(), 5000);
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return code === 0
      ? Result.succeed()
      : Result.fail(
          new NotificationError({
            detail: `通知を出せませんでした（${stderr.trim() || `終了コード ${code}`}）。`,
          }),
        );
  } catch (cause) {
    return Result.fail(
      new NotificationError({
        detail: "osascript を実行できませんでした。",
        cause,
      }),
    );
  }
};

/** 通知の本文に使うスレッド名（長ければ省略する）。 */
export const threadNameForNotification = (title: string, max = 80): string => {
  const name = title.replace(/\s+/g, " ").trim();
  if (name === "") return UNTITLED;
  const chars = [...name];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : name;
};

/**
 * 回答の完了を通知する関数を作る。ChatService の onAnswerFinish から呼ぶ。
 * 通知に失敗しても回答には影響させず、最初の 1 回だけ警告を出す（許可していない場合など）。
 */
export const createAnswerNotifier = (deps: {
  chats: Pick<ChatRepository, "getChat">;
  notify: Notify;
  onError?: (error: NotificationError) => void;
}) => {
  let warned = false;
  return async (event: { chatId: string }): Promise<void> => {
    const chat = deps.chats.getChat(event.chatId);
    if (Result.isFailure(chat)) return;
    const result = await deps.notify(
      ANSWER_NOTIFICATION_TITLE,
      threadNameForNotification(chat.value.chat.title),
    );
    if (Result.isFailure(result) && !warned) {
      warned = true;
      deps.onError?.(result.error);
    }
  };
};
