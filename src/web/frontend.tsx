/**
 * Web UI のエントリポイント（index.html から読み込む）。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AUTH_MODE_PATH } from "../server/auth-mode.ts";
import { App } from "./app.tsx";
import { createApiClient } from "./lib/orpc.ts";
import { type Access, resolveAccess, takeToken } from "./lib/token.ts";

const token = takeToken(window.location, window.sessionStorage, (url) =>
  window.history.replaceState(null, "", url),
);

const root = document.getElementById("root");
if (root === null) {
  throw new Error("#root が見つかりません");
}

const render = (access: Access) =>
  access.kind === "missing" ? (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <p>
        アクセス用のトークンがありません。ターミナルに表示された URL
        から開いてください。
      </p>
    </div>
  ) : (
    <StrictMode>
      <App
        api={createApiClient(
          access.kind === "token" ? access.token : undefined,
        )}
      />
    </StrictMode>
  );

const access = await resolveAccess(token, async () => {
  const response = await fetch(AUTH_MODE_PATH);
  return response.ok ? response.json() : undefined;
});

// Bun の HMR で root を作り直さないようにする
// biome-ignore lint/suspicious/noAssignInExpressions: Bun HMR pattern
(import.meta.hot.data.root ??= createRoot(root)).render(render(access));
