import { Result } from "@praha/byethrow";
import type { QueueRepository } from "../db/queue-repository.ts";
import type { ChatService, ChatUIMessage } from "./chat-service.ts";
import type { RunnerRegistry } from "./runner-registry.ts";

/**
 * 予約したメッセージ（#102）を、分岐ごとに 1 件ずつ送る。
 *
 * - 先の回答が正常に終わったら次を送る。停止・エラーで終わったら一時停止する
 * - 同時生成の上限に当たったら待ち、どこかの生成が終わったら送り直す
 * - 送るときは予約の id を発話の id にする。その発話がもうあれば送信済みとみなして消す（重複送信しない）
 */
export const createQueueDispatcher = (deps: {
  queue: QueueRepository;
  registry: Pick<RunnerRegistry, "get">;
  chatService: Pick<ChatService, "send">;
  onError?: (error: unknown) => void;
}) => {
  const { queue, registry } = deps;
  const onError =
    deps.onError ??
    ((error: unknown) =>
      console.warn("予約したメッセージを送れませんでした:", error));

  /** 分岐の次の予約を送る。送ったら true。 */
  const dispatch = (chatId: string): boolean => {
    if (registry.get(chatId) !== undefined) return false;
    const paused = queue.isPaused(chatId);
    if (Result.isFailure(paused) || paused.value) return false;
    const items = queue.list(chatId);
    if (Result.isFailure(items)) {
      onError(items.error);
      return false;
    }
    const next = items.value.find((item) => item.status === "pending");
    if (next === undefined) return false;

    const sent = queue.isSent(chatId, next.id);
    if (Result.isSuccess(sent) && sent.value) {
      queue.remove(next.id);
      return dispatch(chatId);
    }
    queue.setStatus(next.id, "sending");
    const result = deps.chatService.send({
      chatId,
      message: {
        id: next.id,
        role: "user",
        parts: next.parts as ChatUIMessage["parts"],
      },
    });
    if (Result.isSuccess(result)) {
      queue.remove(next.id);
      return true;
    }
    // 上限や生成中なら、あとで送り直す
    queue.setStatus(next.id, "pending");
    const name = result.error.name;
    if (name !== "TooManyRunnersError" && name !== "ChatAlreadyRunningError") {
      onError(result.error);
      queue.setPaused(chatId, true);
    }
    return false;
  };

  /** 送信待ちのある分岐をすべて送れるだけ送る（上限で待っていた分岐のため）。 */
  const dispatchAll = () => {
    const chatIds = queue.chatsWithPending();
    if (Result.isFailure(chatIds)) {
      onError(chatIds.error);
      return;
    }
    for (const chatId of chatIds.value) {
      dispatch(chatId);
    }
  };

  return {
    dispatch,
    dispatchAll,
    /** 分岐の生成が終わったとき。正常に終わったら次を送り、止まったら一時停止する。 */
    onRunnerFinish: (
      chatId: string,
      outcome: "success" | "aborted" | "error",
    ) => {
      if (outcome !== "success") {
        const items = queue.list(chatId);
        if (Result.isSuccess(items) && items.value.length > 0) {
          queue.setPaused(chatId, true);
        }
      } else {
        dispatch(chatId);
      }
      dispatchAll();
    },
    /** 一時停止を解いて送り始める。 */
    resume: (chatId: string) => {
      queue.setPaused(chatId, false);
      dispatch(chatId);
    },
  };
};

export type QueueDispatcher = ReturnType<typeof createQueueDispatcher>;
