/** 承認待ちを知らせるためのブラウザ通知。送信時（ユーザー操作の中）に許可を求める。 */
export const requestNotificationPermission = (): void => {
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "default"
  ) {
    void Notification.requestPermission();
  }
};

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

export const notifyAwaitingApproval = (chatTitle: string): void => {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted" ||
    !document.hidden
  ) {
    return;
  }
  new Notification("cc-manabu: ツールの承認待ち", {
    body: `「${chatTitle || "新しい会話"}」で Claude がツールの実行を待っています。`,
    tag: "cc-manabu-approval",
  });
};
