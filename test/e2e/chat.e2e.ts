import { expect, type Page, test } from "@playwright/test";

const TOKEN = "e2e-token";

const open = async (page: Page) => {
  await page.goto(`/#token=${TOKEN}`);
  await expect(page.getByText("Claude Code 0.0.0-e2e")).toBeVisible();
};

const newChat = async (page: Page) => {
  // 無題の会話もサイドバーに「新しい会話」と表示されるので、aria-label で作成ボタンを指す
  await page.getByLabel("新しい会話", { exact: true }).click();
  await expect(page).toHaveURL(/\/c\/.+/);
};

const send = async (page: Page, text: string) => {
  const box = page.getByRole("textbox", { name: "メッセージ" });
  await box.fill(text);
  await box.press("Enter");
};

const idle = (page: Page) =>
  expect(page.getByRole("button", { name: "送信", exact: true })).toBeVisible({
    timeout: 15_000,
  });

test("トークンを URL から消し、送信した発話に応答がストリーミングされる", async ({
  page,
}) => {
  await open(page);
  await expect(page).not.toHaveURL(/token=/);
  await newChat(page);
  await send(page, "こんにちは");
  await expect(page.getByText("了解: こんにちは")).toBeVisible();
  await idle(page);
  // 使用量とタイトル
  await expect(
    page.getByText(/入力 10・出力 5 トークン/).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "会話一覧" }).getByText("こんにちは"),
  ).toBeVisible();
});

test("トークンが無ければ案内を表示する", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await expect(
    page.getByText("アクセス用のトークンがありません"),
  ).toBeVisible();
  await context.close();
});

test("生成中にリロードしても、同じ会話が開いて続きが表示される", async ({
  page,
}) => {
  await open(page);
  await newChat(page);
  await send(page, "ゆっくり数えて");
  await expect(page.locator("main")).toContainText("3");
  await page.reload();
  await expect(page.locator("main")).toContainText("40", { timeout: 15_000 });
  await idle(page);
});

test("承認カードで許可・拒否でき、承認待ちがタブタイトルに出る", async ({
  page,
}) => {
  await open(page);
  await newChat(page);

  await send(page, "承認が必要な操作をして");
  const card = page.getByRole("region", { name: "ツール実行の承認" });
  await expect(card).toContainText("touch e2e.txt");
  await expect(page).toHaveTitle(/承認待ち/);
  await card.getByRole("button", { name: "許可" }).click();
  await expect(page.getByText("許可されました")).toBeVisible();
  await expect(page.getByText("Bash の実行を許可しました")).toBeVisible();
  await idle(page);
  await expect(page).toHaveTitle("cc-manabu");

  await send(page, "もう一度承認が必要な操作をして");
  const second = page.getByRole("region", { name: "ツール実行の承認" });
  await second.getByRole("button", { name: "拒否" }).click();
  await page
    .getByRole("textbox", { name: "拒否する理由" })
    .fill("今回はやめて");
  await second.getByRole("button", { name: "拒否する" }).click();
  await expect(page.getByText("拒否されました", { exact: true })).toBeVisible();
  await expect(page.getByText("今回はやめて")).toBeVisible();
});

test("停止・再生成・編集", async ({ page }) => {
  await open(page);
  await newChat(page);

  // 停止
  await send(page, "ゆっくり数えて");
  await expect(page.locator("main")).toContainText("2");
  await page.getByRole("button", { name: "停止" }).click();
  await idle(page);
  await expect(page.locator("main")).not.toContainText("40");

  // 再生成
  await send(page, "一回目");
  await expect(page.getByText("了解: 一回目")).toBeVisible();
  await idle(page);
  await page.getByRole("button", { name: "再生成" }).click();
  await idle(page);
  await expect(page.getByText("了解: 一回目")).toHaveCount(1);

  // 編集（それより後ろは消える）
  const message = page.locator("main .group").filter({ hasText: "一回目" });
  await message.hover();
  await message.getByRole("button", { name: "この発話を編集" }).click();
  await page.getByRole("textbox", { name: "発話を編集" }).fill("書き換えた");
  await page.getByRole("button", { name: "送信", exact: true }).first().click();
  await expect(page.getByText("了解: 書き換えた")).toBeVisible();
  await idle(page);
  await expect(page.getByText("了解: 一回目")).toHaveCount(0);
});

test("会話の切り替え・名前変更・削除", async ({ page }) => {
  await open(page);
  await newChat(page);
  await send(page, "一つ目の会話");
  await idle(page);
  await newChat(page);
  await send(page, "二つ目の会話");
  await idle(page);

  const list = page.getByRole("navigation", { name: "会話一覧" });
  await list.getByText("一つ目の会話").click();
  await expect(page.getByText("了解: 一つ目の会話")).toBeVisible();

  const item = list.locator("li").filter({ hasText: "一つ目の会話" });
  await item.hover();
  await item.getByRole("button", { name: /の名前を変える/ }).click();
  await page.getByRole("textbox", { name: "会話の名前" }).fill("名前を変えた");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(list.getByText("名前を変えた")).toBeVisible();

  const renamed = list.locator("li").filter({ hasText: "名前を変えた" });
  await renamed.hover();
  await renamed.getByRole("button", { name: /を削除$/ }).click();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await expect(list.getByText("名前を変えた")).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});
