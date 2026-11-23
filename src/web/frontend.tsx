/**
 * Web UI のエントリポイント（index.html から読み込む）。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { createApiClient } from "./lib/orpc.ts";
import { takeToken } from "./lib/token.ts";

const token = takeToken(window.location, window.sessionStorage, (url) =>
  window.history.replaceState(null, "", url),
);

const root = document.getElementById("root");
if (root === null) {
  throw new Error("#root が見つかりません");
}

const app =
  token === undefined ? (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <p>
        アクセス用のトークンがありません。ターミナルに表示された URL
        から開いてください。
      </p>
    </div>
  ) : (
    <StrictMode>
      <App api={createApiClient(token)} />
    </StrictMode>
  );

// Bun の HMR で root を作り直さないようにする
// biome-ignore lint/suspicious/noAssignInExpressions: Bun HMR pattern
(import.meta.hot.data.root ??= createRoot(root)).render(app);
