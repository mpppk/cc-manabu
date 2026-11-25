/**
 * デスクトップアプリ版のビルドで `@anthropic-ai/claude-agent-sdk` の代わりに使う。
 * Agent SDK は Node で動くのでブラウザには入れられない。cc-manabu は型と `query()` しか使わず、
 * デスクトップアプリ版では query を process-query.ts に差し替えるので、これが呼ばれることはない。
 */
export const query = (): never => {
  throw new Error(
    "Agent SDK はデスクトップアプリ版では使えません（process-query.ts を使ってください）",
  );
};
