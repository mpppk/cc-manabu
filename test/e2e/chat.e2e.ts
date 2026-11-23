import path from "node:path";
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

/** 入力欄に画像ファイルを貼り付ける（クリップボードの画像だけを貼った状態）。 */
const pasteImage = (page: Page, init: { width: number; height: number }) =>
  page
    .getByRole("textbox", { name: "メッセージ" })
    .evaluate(async (textarea, { width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("no 2d context");
      context.fillStyle = "#00d";
      context.fillRect(0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (blob === null) throw new Error("toBlob failed");
      const data = new DataTransfer();
      data.items.add(new File([blob], "pasted.png", { type: "image/png" }));
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, init);

test("画像を添付して送れる（選択・貼り付け・縮小・取り消し・拡大）", async ({
  page,
}) => {
  await open(page);
  await newChat(page);
  const attachments = page.getByRole("list", { name: "添付する画像" });
  const fileInput = page.getByTestId("image-input");
  const fixture = path.join(
    import.meta.dirname,
    "..",
    "fixtures",
    "images",
    "red-7.png",
  );

  // 対応していない形式はエラー
  await fileInput.setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(page.getByRole("alert")).toContainText("PNG・JPEG・GIF・WebP");

  // ファイル選択で添付し、取り消せる
  await fileInput.setInputFiles(fixture);
  await expect(attachments.getByRole("img")).toHaveCount(1);
  await page.getByRole("button", { name: "画像を削除（red-7.png）" }).click();
  await expect(attachments).toHaveCount(0);

  // 選択と貼り付けで 2 枚。大きい画像は長辺 1568px に縮小される
  await fileInput.setInputFiles(fixture);
  await pasteImage(page, { width: 3000, height: 2000 });
  await expect(attachments.getByRole("img")).toHaveCount(2);
  const pasted = attachments.getByRole("img", { name: "pasted.png" });
  await expect
    .poll(() => pasted.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1568);

  await send(page, "これは？");
  await expect(page.getByText("画像 2 枚: これは？")).toBeVisible();
  await idle(page);
  await expect(attachments).toHaveCount(0);

  // 送った発話に画像が表示され、クリックで拡大できる。リロードしても残る
  await page.reload();
  await page.getByRole("button", { name: "画像を拡大（red-7.png）" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("img", { name: "red-7.png" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("画像だけでも送れて、タイトルは「画像」になる", async ({ page }) => {
  await open(page);
  await newChat(page);
  await pasteImage(page, { width: 100, height: 100 });
  await expect(
    page.getByRole("list", { name: "添付する画像" }).getByRole("img"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await expect(page.getByText("画像 1 枚:")).toBeVisible();
  await idle(page);
  await expect(
    page.getByRole("navigation", { name: "会話一覧" }).getByText("画像", {
      exact: true,
    }),
  ).toBeVisible();
});

const createProject = async (page: Page, name: string) => {
  await page.getByRole("button", { name: "新しいプロジェクト" }).click();
  await page.getByRole("textbox", { name: "プロジェクトの名前" }).fill(name);
  await page.getByRole("button", { name: "作成" }).click();
  await expect(page).toHaveURL(/\/p\/.+/);
  await expect(
    page.getByRole("combobox", { name: "プロジェクト" }),
  ).toHaveValue(/.+/);
};

test("プロジェクトでスレッドをまとめ、既存のスレッドを追加できる", async ({
  page,
}) => {
  await open(page);
  const list = page.getByRole("navigation", { name: "会話一覧" });
  const projectSelect = page.getByRole("combobox", { name: "プロジェクト" });

  // 未所属のスレッドを 1 つ作っておく
  await newChat(page);
  await send(page, "あとで追加する会話");
  await idle(page);

  // プロジェクトを 2 つ作り、それぞれにスレッドを作る
  await createProject(page, "認可基盤");
  await expect(
    list.getByText("このプロジェクトにはまだ会話がありません。"),
  ).toBeVisible();
  await newChat(page);
  await send(page, "認可の会話");
  await idle(page);
  await createProject(page, "家計簿");
  await newChat(page);
  await send(page, "家計簿の会話");
  await idle(page);

  // 切り替えると、それぞれのスレッドだけが並ぶ
  await projectSelect.selectOption({ label: "認可基盤" });
  await expect(list.getByText("認可の会話")).toBeVisible();
  await expect(list.getByText("家計簿の会話")).toHaveCount(0);
  await projectSelect.selectOption({ label: "未所属のスレッド" });
  await expect(list.getByText("あとで追加する会話")).toBeVisible();
  await expect(list.getByText("認可の会話")).toHaveCount(0);

  // 未所属のスレッドを追加すると、過去のメッセージごと移って続けられる
  await projectSelect.selectOption({ label: "認可基盤" });
  await page.getByRole("button", { name: "既存のスレッドを追加" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "「あとで追加する会話」を追加" })
    .click();
  await page.getByRole("button", { name: "閉じる" }).click();
  await list.getByText("あとで追加する会話").click();
  await expect(page.getByText("了解: あとで追加する会話")).toBeVisible();
  await send(page, "続きの発話");
  await expect(page.getByText("了解: 続きの発話")).toBeVisible();
  await idle(page);

  // リロードしてもプロジェクトと所属は保たれる
  await page.reload();
  await expect(projectSelect).toHaveValue(/.+/);
  await expect(projectSelect.locator("option:checked")).toHaveText("認可基盤");
  await expect(list.getByText("あとで追加する会話")).toBeVisible();
  await expect(list.getByText("認可の会話")).toBeVisible();

  // プロジェクトから外すと未所属に戻る
  const item = list.locator("li").filter({ hasText: "あとで追加する会話" });
  await item.hover();
  await item.getByRole("button", { name: /をプロジェクトから外す$/ }).click();
  await expect(list.getByText("あとで追加する会話")).toHaveCount(0);

  // 名前を変えて、削除するとスレッドは未所属に戻る
  await page
    .getByRole("button", { name: "プロジェクトの名前を変える" })
    .click();
  await page.getByRole("textbox", { name: "プロジェクトの名前" }).fill("認可");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(projectSelect.locator("option:checked")).toHaveText("認可");
  await page.getByRole("button", { name: "プロジェクトを削除" }).click();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(projectSelect.locator("option:checked")).toHaveText(
    "未所属のスレッド",
  );
  await expect(list.getByText("認可の会話")).toBeVisible();
  await expect(list.getByText("あとで追加する会話")).toBeVisible();
  await expect(list.getByText("家計簿の会話")).toHaveCount(0);
});
