/**
 * 承認待ちの知らせ方。ブラウザ版は Notification API、デスクトップアプリ版は
 * アプリの通知に差し替える（{@link setApprovalNotifier}）。
 */
export type ApprovalNotifier = {
  /** 送信時（ユーザー操作の中）に、通知の許可を求める。 */
  requestPermission: () => void;
  /** 承認待ちになった会話を知らせる。見えているときに知らせるかは実装が決める。 */
  notify: (chatTitle: string) => void;
};

const browserNotifier: ApprovalNotifier = {
  requestPermission: () => {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      void Notification.requestPermission();
    }
  },
  notify: (chatTitle) => {
    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted" ||
      !document.hidden
    ) {
      return;
    }
    new Notification("cc-manabu: ツールの承認待ち", {
      body: approvalMessage(chatTitle),
      tag: "cc-manabu-approval",
    });
  },
};

let notifier = browserNotifier;

/** 通知の方法を差し替える。画面を描く前に呼ぶ。 */
export const setApprovalNotifier = (next: ApprovalNotifier): void => {
  notifier = next;
};

/** 承認待ちの通知の本文。 */
export const approvalMessage = (chatTitle: string): string =>
  `「${chatTitle || "新しい会話"}」で Claude がツールの実行を待っています。`;

/** 承認待ちを知らせるための通知。送信時（ユーザー操作の中）に許可を求める。 */
export const requestNotificationPermission = (): void =>
  notifier.requestPermission();

/** タブのタイトル。承認待ちがあれば先頭に件数を付ける。 */
export const titleFor = (pendingApprovals: number): string =>
  pendingApprovals > 0
    ? `(${pendingApprovals}) 承認待ち - cc-manabu`
    : "cc-manabu";

/**
 * 新たに承認待ちになった会話を返す（前回の一覧と比べる）。
 */
export const newlyAwaiting = <T extends { id: string; status: string }>(
  previous: ReadonlyMap<string, string>,
  current: readonly T[],
): T[] =>
  current.filter(
    (chat) =>
      chat.status === "awaiting_approval" &&
      previous.get(chat.id) !== "awaiting_approval",
  );

export const notifyAwaitingApproval = (chatTitle: string): void =>
  notifier.notify(chatTitle);
