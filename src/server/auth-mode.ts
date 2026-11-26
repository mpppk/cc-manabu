/**
 * Web UI がトークンを要るかをサーバに問い合わせるためのエンドポイント。
 * サーバとブラウザの両方から読むので、依存を持たせない。
 */

/** 問い合わせ先のパス。 */
export const AUTH_MODE_PATH = "/auth-mode";

/** {@link AUTH_MODE_PATH} の応答。tokenRequired が false なのは MONET_NO_AUTH=1 のときだけ。 */
export type AuthMode = { tokenRequired: boolean };
