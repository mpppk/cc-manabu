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

test("Wiki ページを作り、プロジェクトのスレッドの回答から参照・リンクできる", async ({
  page,
}) => {
  await open(page);
  const list = page.getByRole("navigation", { name: "会話一覧" });
  await createProject(page, "Wiki の検証");
  const projectUrl = page.url();

  // Wiki にページを作る
  await page.getByRole("button", { name: "Wiki", exact: true }).click();
  await expect(page).toHaveURL(/\/wiki$/);
  await page.getByRole("button", { name: "新しいページ" }).click();
  await page
    .getByRole("textbox", { name: "ページのタイトル" })
    .fill("関係タプル");
  await page
    .getByRole("textbox", { name: "別名（カンマ区切り）" })
    .fill("relation tuple");
  await page
    .getByRole("textbox", { name: "本文（Markdown）" })
    .fill("## 定義\n主体・関係・対象の **3 つ組**。");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page).toHaveURL(/\/wiki\/.+/);
  await expect(page.getByRole("heading", { name: "関係タプル" })).toBeVisible();
  await expect(page.getByText("3 つ組")).toBeVisible();
  const pageUrl = page.url();

  // 一覧の検索
  await page.getByRole("button", { name: "一覧" }).click();
  await page.getByRole("textbox", { name: "Wiki を検索" }).fill("タプル");
  await expect(
    page.getByRole("list", { name: "Wiki のページ" }).getByText("関係タプル"),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Wiki を検索" }).fill("存在しない語");
  await expect(page.getByText("一致するページはありません。")).toBeVisible();

  // スレッドから質問すると、引用したページだけがリンクになる
  await page.getByRole("button", { name: "概要", exact: true }).click();
  await expect(page).toHaveURL(projectUrl.replace(/#.*$/, ""));
  await newChat(page);
  await send(page, "関係タプルって何？");
  await idle(page);
  const link = page.getByRole("main").locator("a[data-wiki-page]");
  await expect(link).toHaveText("関係タプル");
  await expect(page.getByText("偽のページ")).toBeVisible();
  await expect(page.locator('a[data-wiki-page="fake"]')).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "参照した Wiki" }),
  ).toContainText("関係タプル");
  await link.click();
  await expect(page).toHaveURL(pageUrl.replace(/#.*$/, ""));
  await expect(page.getByRole("heading", { name: "関係タプル" })).toBeVisible();

  // 同じプロジェクトの別のスレッドからも参照できる（別名でも一致する）
  await page.getByRole("button", { name: "概要", exact: true }).click();
  await newChat(page);
  await send(page, "relation tuple の例は？");
  await idle(page);
  await expect(page.getByRole("main").locator("a[data-wiki-page]")).toHaveText(
    "関係タプル",
  );

  // 未所属のスレッドからは参照しない
  await page
    .getByRole("combobox", { name: "プロジェクト" })
    .selectOption({ label: "未所属のスレッド" });
  await newChat(page);
  await send(page, "関係タプルって何？");
  await expect(page.getByText("了解: 関係タプルって何？")).toBeVisible();
  await idle(page);

  // ページを消しても過去の回答は読め、リンク先は削除済みと表示する
  await page.goto(pageUrl.replace(/#.*$/, ""));
  await page.getByRole("button", { name: "ページを削除" }).click();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.getByText("まだページがありません。")).toBeVisible();
  await page.getByRole("button", { name: "概要", exact: true }).click();
  await list.getByText("関係タプルって何？").click();
  await expect(page.getByText(/参照: .*関係タプル/)).toBeVisible();
  await page.getByRole("main").locator("a[data-wiki-page]").click();
  await expect(
    page.getByText("このページは削除されたか、存在しません。"),
  ).toBeVisible();
});

test("回答から用語ページが自動で作られ、編集を保ち、設定で止められる", async ({
  page,
}) => {
  await open(page);
  await createProject(page, "用語の検証");
  const wikiPages = page.getByRole("list", { name: "Wiki のページ" });
  const openWiki = async () => {
    await page.getByRole("button", { name: "Wiki", exact: true }).click();
    await expect(page).toHaveURL(/\/wiki$/);
  };
  /** 用語ページは回答のあとに作られるので、出てくるまで開き直す。 */
  const expectPage = async (title: string) =>
    expect(async () => {
      await page.reload();
      await expect(wikiPages.getByText(title)).toBeVisible({ timeout: 1000 });
    }).toPass();

  await newChat(page);
  await send(page, "「認可モデル」について");
  await idle(page);
  await openWiki();
  await expectPage("認可モデル");
  await expect(wikiPages.getByText("自動作成")).toBeVisible();

  // 自動作成のページから、元の回答を開ける
  await wikiPages.getByText("認可モデル").click();
  await expect(page.getByText("認可モデル の説明。")).toBeVisible();
  await page.getByRole("button", { name: "元の回答を開く" }).click();
  await expect(page).toHaveURL(/\/c\/.+/);
  await expect(page.getByText("了解: 「認可モデル」について")).toBeVisible();

  // 本文を編集してから同じ用語が出てきても、編集内容は保たれ、ページは増えない
  await openWiki();
  await wikiPages.getByText("認可モデル").click();
  await page.getByRole("button", { name: "編集" }).click();
  await page
    .getByRole("textbox", { name: "本文（Markdown）" })
    .fill("利用者が書いた説明");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("利用者が書いた説明")).toBeVisible();
  await page.getByRole("button", { name: "概要", exact: true }).click();
  await page
    .getByRole("navigation", { name: "会話一覧" })
    .getByText("「認可モデル」について")
    .click();
  await send(page, "「認可モデル」と「関係タプル」の違い");
  await idle(page);
  await openWiki();
  await expectPage("関係タプル");
  await expect(wikiPages.getByText("認可モデル")).toHaveCount(1);
  await wikiPages.getByText("認可モデル").click();
  await expect(page.getByText("利用者が書いた説明")).toBeVisible();

  // 設定で止めると、新しい用語のページは作られない
  await page.getByRole("button", { name: "プロジェクトの設定" }).click();
  const toggle = page.getByRole("checkbox", {
    name: /回答から用語ページを自動で作る/,
  });
  await expect(toggle).toBeChecked();
  await expect(page.getByRole("dialog")).toContainText("利用枠");
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await page.getByRole("button", { name: "閉じる" }).click();
  await page.getByRole("button", { name: "概要", exact: true }).click();
  await newChat(page);
  await send(page, "「止めたあとの語」について");
  await idle(page);
  await openWiki();
  await expect(page.getByText("自動作成: オフ")).toBeVisible();
  await page.waitForTimeout(500);
  await page.reload();
  await expect(wikiPages.getByText("関係タプル")).toBeVisible();
  await expect(wikiPages.getByText("止めたあとの語")).toHaveCount(0);
});

test("回答中の用語から説明を開き、Wiki へ移って回答に戻れる", async ({
  page,
}) => {
  await open(page);
  const createWikiPage = async (
    title: string,
    aliases: string,
    body: string,
  ) => {
    await page.getByRole("button", { name: "Wiki", exact: true }).click();
    await page.getByRole("button", { name: "新しいページ" }).click();
    await page.getByRole("textbox", { name: "ページのタイトル" }).fill(title);
    await page
      .getByRole("textbox", { name: "別名（カンマ区切り）" })
      .fill(aliases);
    await page.getByRole("textbox", { name: "本文（Markdown）" }).fill(body);
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await page.getByRole("button", { name: "概要", exact: true }).click();
  };
  const terms = page.getByRole("main").locator("button[data-wiki-term]");
  const card = page.getByRole("dialog", { name: "用語の説明" });

  // 別のプロジェクトに同じ名前の用語を作っておく
  await createProject(page, "別のプロジェクト");
  await createWikiPage("関係タプル", "", "別のプロジェクトでの定義。");
  await newChat(page);
  await send(page, "関係タプル とは");
  await idle(page);
  await terms.first().hover();
  await expect(card).toContainText("別のプロジェクトでの定義。");

  await createProject(page, "用語プレビュー");
  await createWikiPage(
    "関係タプル",
    "relation tuple",
    "## 定義\n主体・関係・対象の **3 つ組**。",
  );
  await newChat(page);
  await send(page, "関係タプル と relation tuple と `関係タプル`");
  await idle(page);

  // 日本語の名前と英語の別名は用語になり、インラインコードと引用リンクの中はならない
  const answer = page
    .getByRole("main")
    .getByText(/了解|参照/)
    .last();
  await expect(answer).toBeVisible();
  await expect(terms).toHaveCount(2);
  await expect(terms.nth(0)).toHaveText("関係タプル");
  await expect(terms.nth(1)).toHaveText("relation tuple");
  await expect(page.getByRole("main").locator("code")).toContainText(
    "関係タプル",
  );

  // マウス: ホバーで所属プロジェクトの要約が出る
  await terms.nth(0).hover();
  await expect(card).toContainText("主体・関係・対象の 3 つ組。");
  await expect(card).not.toContainText("別のプロジェクト");
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);

  // キーボード: フォーカスで要約、Enter で固定、「Wiki で開く」で移動
  await terms.nth(1).focus();
  await expect(card).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(card.getByRole("button", { name: "Wiki で開く" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/wiki\/.+/);
  await expect(page.getByRole("heading", { name: "関係タプル" })).toBeVisible();
  await page.getByRole("button", { name: "回答に戻る" }).click();
  await expect(page).toHaveURL(/\/c\/.+/);

  // クリック（タップ）で固定して開き、外側を押すと閉じる
  await terms.nth(0).click();
  await page.mouse.move(0, 0);
  await expect(card).toBeVisible();
  await page.mouse.click(5, 300);
  await expect(card).toHaveCount(0);

  // 回答のあとに自動作成されたページも、表示中の回答の用語になる
  await send(page, "「認可モデル」について");
  await idle(page);
  await expect(
    page.getByRole("main").locator("button[data-wiki-term]", {
      hasText: "認可モデル",
    }),
  ).toHaveCount(1, { timeout: 15_000 });

  // 編集すると最新の説明を出し、削除しても回答は表示されたまま
  await page.getByRole("button", { name: "Wiki", exact: true }).click();
  await page
    .getByRole("list", { name: "Wiki のページ" })
    .getByText("認可モデル")
    .click();
  await page.getByRole("button", { name: "編集" }).click();
  await page
    .getByRole("textbox", { name: "本文（Markdown）" })
    .fill("編集後の説明");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("編集後の説明")).toBeVisible();
  await page.getByRole("button", { name: "概要", exact: true }).click();
  await page
    .getByRole("navigation", { name: "会話一覧" })
    .getByText("関係タプル と relation tuple")
    .click();
  await expect(page).toHaveURL(/\/c\/.+/);
  const model = page
    .getByRole("main")
    .locator("button[data-wiki-term]", { hasText: "認可モデル" })
    .first();
  await model.hover();
  await expect(card).toContainText("編集後の説明");

  await page.getByRole("button", { name: "Wiki", exact: true }).click();
  await page
    .getByRole("list", { name: "Wiki のページ" })
    .getByText("認可モデル")
    .click();
  await page.getByRole("button", { name: "ページを削除" }).click();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await page.getByRole("button", { name: "概要", exact: true }).click();
  await page
    .getByRole("navigation", { name: "会話一覧" })
    .getByText("関係タプル と relation tuple")
    .click();
  await expect(page.getByText(/了解: 「認可モデル」について/)).toBeVisible();
  await expect(
    page.getByRole("main").locator("button[data-wiki-term]", {
      hasText: "認可モデル",
    }),
  ).toHaveCount(0);
  await expect(terms.first()).toHaveText("関係タプル");
});

test("プロジェクトに関連リンクを登録し、開き、編集・削除できる", async ({
  page,
}) => {
  await open(page);
  await createProject(page, "リンクの検証");
  const links = page.getByRole("list", { name: "関連リンク" });
  const add = async (url: string, label = "") => {
    await page.getByRole("textbox", { name: "URL" }).last().fill(url);
    await page
      .getByRole("textbox", { name: "表示名（任意）" })
      .last()
      .fill(label);
    await page.getByRole("button", { name: "追加", exact: true }).click();
  };

  // http / https 以外はエラー
  await add("javascript:alert(1)");
  await expect(page.getByRole("alert")).toContainText("http または https");

  await add("https://github.com/example/authz", "リポジトリ");
  await add("https://example.com/design");
  await expect(links.getByRole("link")).toHaveCount(2);
  const repo = links.getByRole("link", { name: /リポジトリ/ });
  await expect(repo).toHaveAttribute(
    "href",
    "https://github.com/example/authz",
  );
  await expect(repo).toHaveAttribute("target", "_blank");
  // 表示名を省略すると URL を表示する
  await expect(
    links.getByRole("link", { name: "https://example.com/design" }),
  ).toBeVisible();

  // 新しいタブで開ける
  const popup = page.waitForEvent("popup");
  await repo.click();
  await (await popup).close();

  // 編集と削除
  await page
    .getByRole("button", { name: "「https://example.com/design」を編集" })
    .click();
  await page
    .getByRole("textbox", { name: "表示名（任意）" })
    .first()
    .fill("設計資料");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(links.getByRole("link", { name: /設計資料/ })).toBeVisible();
  await page.getByRole("button", { name: "「リポジトリ」を削除" }).click();
  await expect(links.getByRole("link")).toHaveCount(1);

  // 開き直しても残り、別のプロジェクトには出ない
  await page.reload();
  await expect(links.getByRole("link", { name: /設計資料/ })).toBeVisible();
  await createProject(page, "別のリンク");
  await expect(page.getByText("よく開く URL を登録できます")).toBeVisible();
  await page
    .getByRole("combobox", { name: "プロジェクト" })
    .selectOption({ label: "リンクの検証" });
  await expect(links.getByRole("link")).toHaveCount(1);
});
