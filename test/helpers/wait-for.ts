/** 条件が満たされるまで待つ（非同期に更新される状態のテスト用）。 */
export const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: timed out");
    }
    await Bun.sleep(2);
  }
};
