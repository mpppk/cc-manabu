import { expect, test } from "@playwright/test";
import { NO_AUTH_PORT } from "../../playwright.config.ts";

const NO_AUTH_BASE = `http://127.0.0.1:${NO_AUTH_PORT}`;

test("CC_MANABU_NO_AUTH=1 のサーバは、トークン付きの URL でなくても開ける", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${NO_AUTH_BASE}/`);
  await expect(page.getByText("Claude Code 0.0.0-e2e")).toBeVisible();
  await expect(page.getByText("アクセス用のトークンがありません")).toHaveCount(
    0,
  );
  // 会話一覧などの API もトークンなしで呼べている
  await page.getByLabel("新しい会話", { exact: true }).click();
  await expect(page).toHaveURL(/\/c\/.+/);
  await context.close();
});
