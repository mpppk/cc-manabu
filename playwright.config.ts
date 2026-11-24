import { defineConfig, devices } from "@playwright/test";

const PORT = 45200;
/** トークンを要求しないモード（CC_MANABU_NO_AUTH=1 相当）のサーバ。test/e2e/no-auth.e2e.ts で使う。 */
export const NO_AUTH_PORT = 45201;

/**
 * E2E テスト（test/e2e/*.e2e.ts）。モックの Claude（test/e2e/scripted-query.ts）で本物の UI を動かす。
 *
 *   bun run test:e2e
 */
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "off",
  },
  webServer: [
    {
      command: "bun test/e2e/server.ts",
      url: `http://127.0.0.1:${PORT}/`,
      env: { E2E_PORT: String(PORT) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "bun test/e2e/server.ts",
      url: `http://127.0.0.1:${NO_AUTH_PORT}/`,
      env: { E2E_PORT: String(NO_AUTH_PORT), E2E_NO_AUTH: "1" },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
