import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

const TOKEN = "e2e-token";

const open = async (page: Page) => {
  await page.goto(`/#token=${TOKEN}`);
  await expect(page.getByText("Claude Code 0.0.0-e2e")).toBeVisible();
};

/**
 * 今開いている画面のタスク（無ければ未所属）に、サイドバーの行の操作で新しいスレッドを作る。
 * タスクの概要・Wiki（`/t/<id>`）ならそのタスク、スレッドならその所属先。
 */
const newChat = async (page: Page) => {
  const before = page.url();
  const path = new URL(before).pathname;
  const tree = page.getByRole("navigation", { name: "会話一覧" });
  const taskId = /^\/t\/([^/]+)/.exec(path)?.[1];
  const owner =
    taskId !== undefined
      ? tree.locator(`li[data-task-id="${taskId}"]`)
      : path.startsWith("/c/")
        ? tree
            .locator("li[data-task-id], li[data-unassigned]")
            .filter({ has: page.locator('[aria-current="page"]') })
            .last()
        : tree.locator("li[data-unassigned]");
  const row = owner.locator(":scope > div.group");
  await row.hover();
  await row.getByRole("button", { name: /に新しいスレッド$/ }).click();
  await expect(page).not.toHaveURL(before);
  await expect(page).toHaveURL(/\/c\/.+/);
};

const send = async (page: Page, text: string) => {
  const box = page.getByRole("textbox", { name: "メッセージ", exact: true });
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

test("開いているページに起動トークンが渡されたら認証する", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await expect(
    page.getByText("アクセス用のトークンがありません"),
  ).toBeVisible();
  await page.evaluate((token) => {
    window.location.hash = `token=${token}`;
  }, TOKEN);
  await expect(page.getByText("Claude Code 0.0.0-e2e")).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);
  await newChat(page);
  await send(page, "PWA で再起動");
  await expect(page.getByText("了解: PWA で再起動")).toBeVisible();
  await context.close();
});

test("保存済みの回答に含まれる Cosense リンクをキーボードで開ける", async ({
  page,
  context,
}) => {
  await context.route("https://cosen.se/**", (route) =>
    route.fulfill({ body: "Cosense" }),
  );
  await open(page);
  await newChat(page);
  await send(page, "参照先は [/Nota/日本語 ページ#1]");
  const link = page.getByRole("link", {
    name: "[/Nota/日本語 ページ#1]",
    exact: true,
  });
  const url = `https://cosen.se/Nota/${encodeURIComponent("日本語 ページ#1")}`;
  await expect(link).toHaveAttribute("href", url);
  await idle(page);
  await page.reload();
  const opened = page.waitForEvent("popup");
  await link.press("Enter");
  await expect(await opened).toHaveURL(url);
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

test("回答を質問ごとに開閉でき、生成中の開閉状態を保つ", async ({ page }) => {
  await open(page);
  await newChat(page);
  // ヘッダーにも会話の名前（最初の質問）が出るので、チャットの中だけを見る
  const main = page.getByRole("region", { name: "メインのチャット" });
  // 閉じた回答は要約を出すので、名前は「回答を開く: <要約>」になる
  const toggles = main.getByRole("button", { name: /^回答を(開く|閉じる)/ });
  const firstAnswer = main.getByText("了解: 最初の質問");
  await send(page, "最初の質問");
  await idle(page);
  await expect(toggles.first()).toHaveAttribute("aria-expanded", "true");

  await send(page, "ゆっくり数えて");
  const streaming = main.locator("[data-assistant-message]").last();
  await expect(streaming).toContainText("3");
  await expect(toggles.first()).toHaveAttribute("aria-expanded", "false");
  await expect(firstAnswer).toBeHidden();
  // 閉じた回答には、「回答を開く」の代わりに回答のあとに作られた要約を出す
  await expect(toggles.first()).toHaveAccessibleName(
    "回答を開く: 要約（9 文字の回答）",
  );
  await expect(main.getByText("最初の質問", { exact: true })).toBeVisible();
  await expect(toggles.last()).toHaveAttribute("aria-expanded", "true");
  await toggles.last().press("Space");
  await expect(streaming).toBeHidden();
  await expect(streaming).toContainText("10");
  await expect(toggles.last()).toHaveAttribute("aria-expanded", "false");
  await expect(main.getByRole("button", { name: "停止" })).toBeVisible();
  await toggles.last().press("Enter");
  await expect(streaming).toBeVisible();
  await expect(streaming).toContainText("10");
  await idle(page);

  await toggles.first().click();
  await expect(firstAnswer).toBeVisible();
  await expect(
    main
      .locator("[data-assistant-message]")
      .first()
      .getByText(/入力 10・出力 5 トークン/),
  ).toBeVisible();
  await toggles.last().click();
  await expect(streaming).toBeHidden();
  await page.reload();
  await expect(toggles.first()).toHaveAttribute("aria-expanded", "false");
  // 保存した要約は、読み込み直しても出る
  await expect(toggles.first()).toHaveAccessibleName(
    "回答を開く: 要約（9 文字の回答）",
  );
  await expect(toggles.last()).toHaveAttribute("aria-expanded", "true");
  await expect(toggles.last()).toHaveText("回答を閉じる");
  await expect(firstAnswer).toBeHidden();
  await expect(streaming).toBeVisible();
});

test("承認カードで許可・拒否でき、承認待ちがタブタイトルに出る", async ({
  page,
}) => {
  await open(page);
  await newChat(page);

  await send(page, "承認が必要な操作をして");
  const card = page.getByRole("region", { name: "ツール実行の承認" });
  await expect(card).toContainText("touch e2e.txt");
  await page.getByRole("button", { name: "回答を閉じる" }).click();
  await expect(card).toBeVisible();
  await expect(page).toHaveTitle(/承認待ち/);
  await card.getByRole("button", { name: "許可" }).click();
  await idle(page);
  await expect(page.getByText("許可されました")).toBeHidden();
  await page.getByRole("button", { name: "回答を開く" }).click();
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

  // 停止（ヘッダーの利用枠のリセット時刻に数字が出るので、チャットの中だけを見る）
  const chat = page.getByRole("region", { name: "メインのチャット" });
  await send(page, "ゆっくり数えて");
  await expect(chat).toContainText("2");
  await page.getByRole("button", { name: "停止" }).click();
  await idle(page);
  await expect(chat).not.toContainText("40");

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
  const firstAnswer = page.getByText("了解: 一つ目の会話");
  await expect(firstAnswer).toBeVisible();
  await idle(page);
  await newChat(page);
  await expect(firstAnswer).toHaveCount(0);
  await send(page, "二つ目の会話");
  await expect(page.getByText("了解: 二つ目の会話")).toBeVisible();
  await idle(page);

  const list = page.getByRole("navigation", { name: "会話一覧" });
  await list.getByText("一つ目の会話").click();
  await expect(firstAnswer).toBeVisible();

  const item = list
    .locator("li:not(:has(li))")
    .filter({ hasText: "一つ目の会話" });
  await item.hover();
  await item.getByRole("button", { name: /の名前を変える/ }).click();
  await page.getByRole("textbox", { name: "会話の名前" }).fill("名前を変えた");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(list.getByText("名前を変えた")).toBeVisible();

  const renamed = list
    .locator("li:not(:has(li))")
    .filter({ hasText: "名前を変えた" });
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

/** サイドバーのツリー（環境 → タスク → スレッド）。 */
const sidebarTree = (page: Page) =>
  page.getByRole("navigation", { name: "会話一覧" });

/** 行（環境・タスク・未所属）を、行の操作（ホバーで出る）の名前で見分ける。has に渡せるよう相対で書く。 */
const rowMatching = (page: Page, actionLabel: string) =>
  page
    .locator("div.group")
    .filter({ has: page.locator(`[aria-label="${actionLabel}"]`) });

/** ツリーの行。 */
const treeRow = (page: Page, actionLabel: string) =>
  sidebarTree(page).locator(rowMatching(page, actionLabel));

const taskRow = (page: Page, name: string) =>
  treeRow(page, `「${name}」の概要を開く`);

/** 環境の行（「新しいタスク」の操作はタスクが無くても出る）。 */
const environmentRow = (page: Page, name: string) =>
  treeRow(page, `環境「${name}」に新しいタスク`);

/** タスクの行と、その下のスレッド。 */
const taskItem = (page: Page, name: string) =>
  sidebarTree(page)
    .locator("li")
    .filter({ has: rowMatching(page, `「${name}」の概要を開く`) })
    .last();

/** 環境の行と、その下のタスク。 */
const environmentItem = (page: Page, name: string) =>
  sidebarTree(page)
    .locator("li")
    .filter({ has: rowMatching(page, `環境「${name}」に新しいタスク`) })
    .first();

/** 「未所属のスレッド」の行と、その下のスレッド。 */
const unassignedItem = (page: Page) =>
  sidebarTree(page)
    .locator("li")
    .filter({ has: rowMatching(page, "未所属に新しいスレッド") })
    .first();

/** 行にホバーして、行の操作を押す。 */
const rowAction = async (row: ReturnType<typeof treeRow>, label: string) => {
  await row.hover();
  await row.getByRole("button", { name: label, exact: true }).click();
};

/** 「未所属のスレッド」の行から新しいスレッドを作る。 */
const newUnassignedChat = async (page: Page) => {
  const before = page.url();
  await rowAction(
    treeRow(page, "未所属に新しいスレッド"),
    "未所属に新しいスレッド",
  );
  await expect(page).not.toHaveURL(before);
  await expect(page).toHaveURL(/\/c\/.+/);
};

/** タスクの概要を開く。 */
const openTask = async (page: Page, name: string) => {
  await rowAction(taskRow(page, name), `「${name}」の概要を開く`);
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
};

/** 環境の Wiki のページ一覧を開く。 */
const openWiki = async (page: Page, environment: string) => {
  await rowAction(
    environmentRow(page, environment),
    `環境「${environment}」の Wiki を開く`,
  );
  await expect(page).toHaveURL(/\/wiki$/);
};

/** 環境の行のメニュー（歯車）を開いて項目を選ぶ。 */
const openEnvironmentMenu = async (page: Page, name: string, item: string) => {
  await rowAction(environmentRow(page, name), `環境「${name}」のメニュー`);
  await page.getByRole("menuitem", { name: item }).click();
};

/** タスクの行のメニュー（歯車）を開いて項目を選ぶ。 */
const openTaskMenu = async (page: Page, name: string, item: string) => {
  await rowAction(taskRow(page, name), `「${name}」のメニュー`);
  await page.getByRole("menuitem", { name: item }).click();
};

/** タスクを、同じ名前の新しい環境（と Wiki）で作る。 */
const createTask = async (page: Page, name: string) => {
  await page.getByRole("button", { name: "新しいタスク", exact: true }).click();
  await page.getByRole("textbox", { name: "タスクの名前" }).fill(name);
  await page
    .getByRole("combobox", { name: "タスクの環境" })
    .selectOption({ label: "新しい環境を作る（起動したディレクトリ）" });
  await page.getByRole("button", { name: "作成" }).click();
  await expect(page).toHaveURL(/\/t\/.+/);
  await expect(taskRow(page, name)).toBeVisible();
};

test("タスクでスレッドをまとめ、既存のスレッドを追加できる", async ({
  page,
}) => {
  await open(page);
  const list = sidebarTree(page);
  const unassigned = unassignedItem(page);

  // 未所属のスレッドを 1 つ作っておく
  await newChat(page);
  await send(page, "あとで追加する会話");
  await idle(page);

  // タスクを 2 つ作り、それぞれにスレッドを作る
  await createTask(page, "認可基盤");
  const auth = taskItem(page, "認可基盤");
  await expect(auth.getByText("まだスレッドがありません。")).toBeVisible();
  await newChat(page);
  await send(page, "認可の会話");
  await idle(page);
  await createTask(page, "家計簿");
  await newChat(page);
  await send(page, "家計簿の会話");
  await idle(page);

  // スレッドはタスクの下にまとまり、タスクの行を押すと開閉する
  await expect(auth.getByText("認可の会話")).toBeVisible();
  await expect(auth.getByText("家計簿の会話")).toHaveCount(0);
  await expect(unassigned.getByText("あとで追加する会話")).toBeVisible();
  await expect(unassigned.getByText("認可の会話")).toHaveCount(0);
  const authToggle = taskRow(page, "認可基盤").locator(
    ":scope > button[aria-expanded]",
  );
  await authToggle.click();
  await expect(authToggle).toHaveAttribute("aria-expanded", "false");
  await expect(list.getByText("認可の会話")).toHaveCount(0);
  // 開閉はリロードしても保たれる
  await page.reload();
  await expect(authToggle).toHaveAttribute("aria-expanded", "false");
  await authToggle.click();
  await expect(auth.getByText("認可の会話")).toBeVisible();

  // 未所属のスレッドを追加すると、過去のメッセージごと移って続けられる
  await openTaskMenu(page, "認可基盤", "既存のスレッドを追加");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "「あとで追加する会話」を追加" })
    .click();
  await page.getByRole("button", { name: "閉じる" }).click();
  await auth.getByText("あとで追加する会話").click();
  await expect(page.getByText("了解: あとで追加する会話")).toBeVisible();
  await send(page, "続きの発話");
  await expect(page.getByText("了解: 続きの発話")).toBeVisible();
  await idle(page);

  // リロードしても所属は保たれる
  await page.reload();
  await expect(auth.getByText("あとで追加する会話")).toBeVisible();
  await expect(auth.getByText("認可の会話")).toBeVisible();
  await expect(unassigned.getByText("あとで追加する会話")).toHaveCount(0);

  // タスクから外すと未所属に戻る
  const item = auth
    .locator("li:not(:has(li))")
    .filter({ hasText: "あとで追加する会話" });
  await item.hover();
  await item.getByRole("button", { name: /をタスクから外す$/ }).click();
  await expect(auth.getByText("あとで追加する会話")).toHaveCount(0);
  await expect(unassigned.getByText("あとで追加する会話")).toBeVisible();

  // 未所属の行からも新しいスレッドを作れる
  await newUnassignedChat(page);
  await send(page, "未所属の新しい会話");
  await idle(page);
  await expect(unassigned.getByText("未所属の新しい会話")).toBeVisible();

  // 名前を変えて、削除するとスレッドは未所属に戻る
  await openTaskMenu(page, "認可基盤", "タスクの名前を変える");
  await page.getByRole("textbox", { name: "タスクの名前" }).fill("認可");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(taskRow(page, "認可")).toBeVisible();
  await openTask(page, "認可");
  await openTaskMenu(page, "認可", "タスクを削除");
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(taskRow(page, "認可")).toHaveCount(0);
  await expect(unassigned.getByText("認可の会話")).toBeVisible();
  await expect(unassigned.getByText("あとで追加する会話")).toBeVisible();
  await expect(unassigned.getByText("家計簿の会話")).toHaveCount(0);
  await expect(taskItem(page, "家計簿").getByText("家計簿の会話")).toHaveCount(
    1,
  );
});

test("Wiki ページを作り、タスクのスレッドの回答から参照・リンクできる", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "Wiki の検証");
  const taskUrl = page.url();

  // Wiki にページを作る
  await openWiki(page, "Wiki の検証");
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
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page).toHaveURL(/\/wiki\/.+/);
  await expect(page.getByRole("heading", { name: "関係タプル" })).toBeVisible();
  await expect(page.getByText("3 つ組")).toBeVisible();
  const pageUrl = page.url();

  // ページの一覧は Wiki 画面の左に出て、開いているページが分かる
  const wikiPages = page.getByRole("list", { name: "Wiki のページ" });
  await expect(
    wikiPages.getByRole("button", { name: /関係タプル/ }),
  ).toHaveAttribute("aria-current", "page");

  // 一覧の検索
  await page.getByRole("textbox", { name: "Wiki を検索" }).fill("タプル");
  await expect(wikiPages.getByText("関係タプル")).toBeVisible();
  await page.getByRole("textbox", { name: "Wiki を検索" }).fill("存在しない語");
  await expect(page.getByText("一致するページはありません。")).toBeVisible();

  // スレッドから質問すると、引用したページだけがリンクになる
  await openTask(page, "Wiki の検証");
  await expect(page).toHaveURL(taskUrl.replace(/#.*$/, ""));
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
  // 引用リンクは右側のペインで開き、「Wiki で開く」で Wiki 画面へ移る
  const chatUrl = page.url();
  const pane = page.getByRole("complementary", { name: "Wiki ページ" });
  await link.click();
  await expect(pane.getByRole("heading", { name: "関係タプル" })).toBeVisible();
  await expect(page).toHaveURL(chatUrl);
  await pane.getByRole("button", { name: "Wiki で開く" }).click();
  await expect(page).toHaveURL(pageUrl.replace(/#.*$/, ""));
  await expect(page.getByRole("heading", { name: "関係タプル" })).toBeVisible();

  // 同じタスクの別のスレッドからも参照できる（別名でも一致する）
  await openTask(page, "Wiki の検証");
  await newChat(page);
  await send(page, "relation tuple の例は？");
  await idle(page);
  await expect(page.getByRole("main").locator("a[data-wiki-page]")).toHaveText(
    "関係タプル",
  );

  // 未所属のスレッドからは参照しない
  await newUnassignedChat(page);
  await send(page, "関係タプルって何？");
  await expect(page.getByText("了解: 関係タプルって何？")).toBeVisible();
  await idle(page);

  // ページを消しても過去の回答は読め、リンク先は削除済みと表示する
  await page.goto(pageUrl.replace(/#.*$/, ""));
  await page.getByRole("button", { name: "ページを削除" }).click();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.getByText("まだページがありません。")).toBeVisible();
  await openTask(page, "Wiki の検証");
  await taskItem(page, "Wiki の検証").getByText("関係タプルって何？").click();
  await expect(page.getByText(/参照: .*関係タプル/)).toBeVisible();
  await page.getByRole("main").locator("a[data-wiki-page]").click();
  await expect(
    pane.getByText("このページは削除されたか、存在しません。"),
  ).toBeVisible();
});

test("回答から用語ページが自動で作られ、編集を保ち、設定で止められる", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "用語の検証");
  const wikiPages = page.getByRole("list", { name: "Wiki のページ" });
  const openTermsWiki = () => openWiki(page, "用語の検証");
  /** 用語ページは回答のあとに作られるので、出てくるまで開き直す。 */
  const expectPage = async (title: string) =>
    expect(async () => {
      await page.reload();
      await expect(wikiPages.getByText(title)).toBeVisible({ timeout: 1000 });
    }).toPass();

  await newChat(page);
  await send(page, "「認可モデル」について");
  await idle(page);
  await openTermsWiki();
  await expectPage("認可モデル");

  // 自動作成のページから、元の回答を開ける
  await wikiPages.getByText("認可モデル").click();
  await expect(page.getByText("認可モデル の説明。")).toBeVisible();
  await page.getByRole("button", { name: "元の回答を開く" }).click();
  await expect(page).toHaveURL(/\/c\/.+/);
  await expect(page.getByText("了解: 「認可モデル」について")).toBeVisible();

  // 本文を編集してから同じ用語が出てきても、編集内容は保たれ、ページは増えない
  await openTermsWiki();
  await wikiPages.getByText("認可モデル").click();
  await page.getByRole("button", { name: "編集" }).click();
  await page
    .getByRole("textbox", { name: "本文（Markdown）" })
    .fill("利用者が書いた説明");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("利用者が書いた説明")).toBeVisible();
  await openTask(page, "用語の検証");
  await page
    .getByRole("navigation", { name: "会話一覧" })
    .getByText("「認可モデル」について")
    .click();
  await send(page, "「認可モデル」と「関係タプル」の違い");
  await idle(page);
  await openTermsWiki();
  await expectPage("関係タプル");
  await expect(wikiPages.getByText("認可モデル")).toHaveCount(1);
  await wikiPages.getByText("認可モデル").click();
  await expect(page.getByText("利用者が書いた説明")).toBeVisible();

  // 設定で止めると、新しい用語のページは作られない
  await openTaskMenu(page, "用語の検証", "タスクの設定");
  const toggle = page.getByRole("checkbox", {
    name: /回答から用語ページを自動で作る/,
  });
  await expect(toggle).toBeChecked();
  await expect(page.getByRole("dialog")).toContainText("利用枠");
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await page.getByRole("button", { name: "閉じる" }).click();
  await openTask(page, "用語の検証");
  await newChat(page);
  await send(page, "「止めたあとの語」について");
  await idle(page);
  await openTermsWiki();
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
    task: string,
    title: string,
    aliases: string,
    body: string,
  ) => {
    await openWiki(page, task);
    await page.getByRole("button", { name: "新しいページ" }).click();
    await page.getByRole("textbox", { name: "ページのタイトル" }).fill(title);
    await page
      .getByRole("textbox", { name: "別名（カンマ区切り）" })
      .fill(aliases);
    await page.getByRole("textbox", { name: "本文（Markdown）" }).fill(body);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await openTask(page, task);
  };
  const terms = page.getByRole("main").locator("button[data-wiki-term]");
  const card = page.getByRole("dialog", { name: "用語の説明" });

  // 別のタスクに同じ名前の用語を作っておく
  await createTask(page, "別のタスク");
  await createWikiPage("別のタスク", "関係タプル", "", "別のタスクでの定義。");
  await newChat(page);
  await send(page, "関係タプル とは");
  await idle(page);
  await terms.first().hover();
  await expect(card).toContainText("別のタスクでの定義。");

  await createTask(page, "用語プレビュー");
  await createWikiPage(
    "用語プレビュー",
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

  // マウス: ホバーで所属タスクの要約が出る
  await terms.nth(0).hover();
  await expect(card).toContainText("主体・関係・対象の 3 つ組。");
  await expect(card).not.toContainText("別のタスク");
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);

  // キーボード: フォーカスで要約、Tab で要約の「Wiki で開く」へ移って Wiki 画面を開く
  await terms.nth(1).focus();
  await expect(card).toBeVisible();
  // 要約は読み込んでから出るので、「Wiki で開く」が出てから Tab で移る
  const openInWiki = card.getByRole("button", { name: "Wiki で開く" });
  await expect(openInWiki).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(openInWiki).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/wiki\/.+/);
  await expect(page.getByRole("heading", { name: "関係タプル" })).toBeVisible();
  await page.getByRole("button", { name: "回答に戻る" }).click();
  await expect(page).toHaveURL(/\/c\/.+/);

  // 回答のあとに自動作成されたページも、表示中の回答の用語になる
  await send(page, "「認可モデル」について");
  await idle(page);
  await expect(
    page.getByRole("main").locator("button[data-wiki-term]", {
      hasText: "認可モデル",
    }),
  ).toHaveCount(1, { timeout: 15_000 });

  // 編集すると最新の説明を出し、削除しても回答は表示されたまま
  await openWiki(page, "用語プレビュー");
  await page
    .getByRole("list", { name: "Wiki のページ" })
    .getByText("認可モデル")
    .click();
  await page.getByRole("button", { name: "編集" }).click();
  await page
    .getByRole("textbox", { name: "本文（Markdown）" })
    .fill("編集後の説明");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("編集後の説明")).toBeVisible();
  await openTask(page, "用語プレビュー");
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

  await openWiki(page, "用語プレビュー");
  await page
    .getByRole("list", { name: "Wiki のページ" })
    .getByText("認可モデル")
    .click();
  await page.getByRole("button", { name: "ページを削除" }).click();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await openTask(page, "用語プレビュー");
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

test("回答中の用語・引用をクリックすると、右側のペインで Wiki ページを開く", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "ペインの検証");
  for (const [title, aliases, body] of [
    ["関係タプル", "relation tuple", "主体・関係・対象の **3 つ組**。"],
    ["認可モデル", "", "権限を決める仕組み。"],
  ] as const) {
    await openWiki(page, "ペインの検証");
    await page.getByRole("button", { name: "新しいページ" }).click();
    await page.getByRole("textbox", { name: "ページのタイトル" }).fill(title);
    await page
      .getByRole("textbox", { name: "別名（カンマ区切り）" })
      .fill(aliases);
    await page.getByRole("textbox", { name: "本文（Markdown）" }).fill(body);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  await openTask(page, "ペインの検証");
  await newChat(page);
  await send(page, "関係タプル と 認可モデル の関係");
  await idle(page);
  const chatUrl = page.url();

  const main = page.getByRole("region", { name: "メインのチャット" });
  const mainInput = main.getByRole("textbox", {
    name: "メッセージ",
    exact: true,
  });
  const pane = page.getByRole("complementary", { name: "Wiki ページ" });
  const tuple = main
    .locator("button[data-wiki-term]", { hasText: "関係タプル" })
    .first();
  const model = main
    .locator("button[data-wiki-term]", { hasText: "認可モデル" })
    .first();
  await mainInput.fill("書きかけの質問");

  // クリックで右側に開き、メインの会話はそのまま
  await tuple.click();
  await expect(pane).toBeFocused();
  await expect(pane.getByRole("heading", { name: "関係タプル" })).toBeVisible();
  await expect(pane).toContainText("主体・関係・対象の 3 つ組。");
  await expect(pane).toContainText("別名: relation tuple");
  await expect(main).toBeVisible();
  await expect(
    main.getByText("関係タプル と 認可モデル の関係", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(chatUrl);

  // 別の用語をクリックすると切り替わり、Escape で閉じると用語にフォーカスが戻る
  await model.click();
  await expect(pane.getByRole("heading", { name: "認可モデル" })).toBeVisible();
  await expect(pane.getByRole("heading", { name: "関係タプル" })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await expect(model).toBeFocused();
  await expect(mainInput).toHaveValue("書きかけの質問");

  // キーボード: Enter で開いてペインにフォーカスが移り、閉じるボタンで戻る
  await tuple.focus();
  await page.keyboard.press("Enter");
  await expect(pane).toBeFocused();
  await expect(pane.getByRole("heading", { name: "関係タプル" })).toBeVisible();
  await pane.getByRole("button", { name: "Wiki ページを閉じる" }).click();
  await expect(pane).toHaveCount(0);
  await expect(tuple).toBeFocused();

  // 引用リンクも同じペインで開き、「Wiki で開く」で Wiki 画面へ移って戻れる
  await main.locator("a[data-wiki-page]").first().click();
  await expect(pane.getByRole("heading")).toHaveCount(1);
  await pane.getByRole("button", { name: "Wiki で開く" }).click();
  await expect(page).toHaveURL(/\/wiki\/.+/);
  await page.getByRole("button", { name: "回答に戻る" }).click();
  await expect(page).toHaveURL(chatUrl);
  await expect(mainInput).toHaveValue("書きかけの質問");
  await pane.getByRole("button", { name: "Wiki ページを閉じる" }).click();

  // 右側のペインは 1 つだけ: サイドチャットを開いていても、用語を押すと入れ替わる
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  await selectLastAnswerParagraph(page);
  await main.getByRole("button", { name: "質問", exact: true }).click();
  await expect(side).toBeVisible();
  await model.click();
  await expect(pane.getByRole("heading", { name: "認可モデル" })).toBeVisible();
  await expect(side).toHaveCount(0);
  await pane.getByRole("button", { name: "Wiki ページを閉じる" }).click();

  // 狭い画面ではペインが全面に出て、閉じるとメインの現在地と下書きに戻る
  await page.setViewportSize({ width: 700, height: 740 });
  await tuple.click();
  await expect(pane.getByRole("heading", { name: "関係タプル" })).toBeVisible();
  await expect(main).toBeHidden();
  expect((await pane.boundingBox())?.width).toBe(700);
  await pane.getByRole("button", { name: "Wiki ページを閉じる" }).click();
  await expect(main).toBeVisible();
  await expect(mainInput).toHaveValue("書きかけの質問");
  await expect(tuple).toBeFocused();
});

test("タスクに関連リンクを登録し、開き、編集・削除できる", async ({ page }) => {
  await open(page);
  await createTask(page, "リンクの検証");
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
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(links.getByRole("link", { name: /設計資料/ })).toBeVisible();
  await page.getByRole("button", { name: "「リポジトリ」を削除" }).click();
  await expect(links.getByRole("link")).toHaveCount(1);

  // 開き直しても残り、別のタスクには出ない
  await page.reload();
  await expect(links.getByRole("link", { name: /設計資料/ })).toBeVisible();
  await createTask(page, "別のリンク");
  await expect(page.getByText("よく開く URL を登録できます")).toBeVisible();
  await openTask(page, "リンクの検証");
  await expect(links.getByRole("link")).toHaveCount(1);
});

test("タスクの進捗を記録し、一覧で状態ごとに確認できる", async ({ page }) => {
  await open(page);
  const status = page.getByRole("combobox", { name: "状態" });
  const progress = page.getByRole("region", { name: "進捗" });

  await createTask(page, "進捗A");
  await expect(status).toHaveValue("not_started");
  await expect(progress).toContainText("最終更新: —");

  // 状態はすぐ保存、次にやること・進捗メモは「進捗を保存」で保存
  await status.selectOption({ label: "進行中" });
  await expect(progress).not.toContainText("最終更新: —");
  await page
    .getByRole("textbox", { name: "次にやること" })
    .fill("検証環境で権限モデルを試す");
  await page
    .getByRole("textbox", { name: "進捗メモ" })
    .fill("設計と調査を複数のスレッドで進めた");
  await page.getByRole("button", { name: "進捗を保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  const updatedText = await progress.getByText(/最終更新:/).textContent();

  // 別のタスクには反映されない
  await createTask(page, "進捗B");
  await expect(status).toHaveValue("not_started");
  await expect(page.getByRole("textbox", { name: "次にやること" })).toHaveValue(
    "",
  );

  // スレッドで会話を続けても、状態と最終更新は変わらない
  await openTask(page, "進捗A");
  await newChat(page);
  await send(page, "進捗の続き");
  await idle(page);
  await openTask(page, "進捗A");
  await expect(status).toHaveValue("in_progress");
  await expect(progress.getByText(/最終更新:/)).toHaveText(updatedText ?? "");

  // 一覧で状態と次にやることを確認し、絞り込める（リロードしても保たれる）
  await page.getByRole("button", { name: "タスク一覧" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  const rows = page.getByRole("row");
  await expect(rows.filter({ hasText: "進捗A" })).toContainText("進行中");
  await expect(rows.filter({ hasText: "進捗A" })).toContainText(
    "検証環境で権限モデルを試す",
  );
  await expect(rows.filter({ hasText: "進捗B" })).toContainText("未着手");
  const filters = page.getByRole("navigation", { name: "状態で絞り込む" });
  await filters.getByRole("button", { name: /^進行中/ }).click();
  await expect(page).toHaveURL(/status=in_progress/);
  await expect(rows.filter({ hasText: "進捗A" })).toBeVisible();
  await expect(rows.filter({ hasText: "進捗B" })).toHaveCount(0);
  await page.reload();
  await expect(
    filters.getByRole("button", { name: /^進行中/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(rows.filter({ hasText: "進捗A" })).toContainText(
    "検証環境で権限モデルを試す",
  );
  await expect(rows.filter({ hasText: "進捗B" })).toHaveCount(0);

  // 完了してもスレッド・Wiki・関連リンクを開け、進行中に戻せる
  await rows.filter({ hasText: "進捗A" }).getByRole("button").click();
  await status.selectOption({ label: "完了" });
  await expect(taskRow(page, "進捗A")).toContainText("完了");
  await expect(page.getByRole("heading", { name: "関連リンク" })).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("button", { name: /進捗の続き/ })
    .click();
  await expect(page.getByText("了解: 進捗の続き")).toBeVisible();
  await openWiki(page, "進捗A");
  await openTask(page, "進捗A");
  await status.selectOption({ label: "進行中" });
  await expect(taskRow(page, "進捗A")).not.toContainText("完了");
});

test("応答から分岐し、同じ会話の中で分岐を切り替えて続けられる", async ({
  page,
}) => {
  await open(page);
  const list = page.getByRole("navigation", { name: "会話一覧" });
  const main = page.getByRole("main");
  const branchSelect = page.getByRole("combobox", { name: "分岐" });
  const branchButtons = main.getByRole("button", { name: "ここから分岐" });

  await newChat(page);
  await send(page, "分岐の設計案は？");
  await idle(page);
  await send(page, "同期で進めて");
  await idle(page);

  // 取り消すと元の表示に戻り、分岐は作られない
  await main.getByRole("button", { name: "回答を開く" }).click();
  await branchButtons.first().click();
  await expect(
    main.getByText("この応答の続きとして分岐を作ります"),
  ).toBeVisible();
  await expect(main.getByText("了解: 同期で進めて")).toHaveCount(0);
  await main.getByRole("button", { name: "取り消す" }).click();
  await expect(main.getByText("了解: 同期で進めて")).toBeVisible();
  await expect(branchSelect).toHaveCount(0);

  // 最初の応答から分岐する
  const rootUrl = page.url();
  await branchButtons.first().click();
  await send(page, "非同期だと？");
  await expect(main.getByText("了解: 非同期だと？")).toBeVisible();
  await idle(page);
  expect(page.url()).not.toBe(rootUrl);
  await expect(main.getByText("了解: 分岐の設計案は？")).toBeHidden();
  await expect(main.getByText("了解: 同期で進めて")).toHaveCount(0);
  await expect(main.getByText(/から引き継いだ履歴/)).toBeVisible();
  await expect(branchSelect.locator("option")).toHaveText([
    "元の会話",
    "非同期だと？（元の会話 から分岐）",
  ]);
  await expect(
    main.getByText("ファイルへの変更はすべての分岐で共有"),
  ).toBeVisible();
  // サイドバーの会話は 1 つのまま
  await expect(
    list.locator("li:not(:has(li))").filter({ hasText: "分岐の設計案は？" }),
  ).toHaveCount(1);

  // 元の会話に切り替えて続ける
  await branchSelect.selectOption({ label: "元の会話" });
  await expect(main.getByText("了解: 同期で進めて")).toBeVisible();
  await send(page, "元の続き");
  await expect(main.getByText("了解: 元の続き")).toBeVisible();
  await idle(page);

  // 分岐に戻って続ける
  await branchSelect.selectOption({
    label: "非同期だと？（元の会話 から分岐）",
  });
  await expect(main.getByText("了解: 非同期だと？")).toBeVisible();
  await send(page, "分岐の続き");
  await expect(main.getByText("了解: 分岐の続き")).toBeVisible();
  await idle(page);
  await expect(main.getByText("了解: 元の続き")).toHaveCount(0);

  // 分岐からさらに分岐する
  await main.getByRole("button", { name: "回答を開く" }).nth(1).click();
  await branchButtons.first().click();
  await send(page, "さらに分岐");
  await expect(main.getByText("了解: さらに分岐")).toBeVisible();
  await idle(page);
  await expect(branchSelect.locator("option")).toHaveCount(3);
  await expect(
    list.locator("li:not(:has(li))").filter({ hasText: "分岐の設計案は？" }),
  ).toHaveCount(1);

  // 元の会話を編集しても、分岐の履歴は残る
  await branchSelect.selectOption({ label: "元の会話" });
  await main.getByText("分岐の設計案は？").first().hover();
  await main.getByRole("button", { name: "この発話を編集" }).first().click();
  await page
    .getByRole("textbox", { name: "発話を編集" })
    .fill("書き直した質問");
  await page.getByRole("button", { name: "送信", exact: true }).first().click();
  await expect(main.getByText("了解: 書き直した質問")).toBeVisible();
  await idle(page);
  await branchSelect.selectOption({
    label: "非同期だと？（元の会話 から分岐）",
  });
  await expect(main.getByText("了解: 分岐の設計案は？")).toBeHidden();
  await main.getByRole("button", { name: "回答を開く" }).first().click();
  await expect(main.getByText("了解: 分岐の設計案は？")).toBeVisible();
  await expect(main.getByText("了解: 分岐の続き")).toBeVisible();

  // リロードしても、最後に選んだ分岐が開く。サイドバーから開いても同じ
  await page.reload();
  await expect(branchSelect).toHaveValue(/.+/);
  await expect(branchSelect.locator("option:checked")).toHaveText(
    "非同期だと？（元の会話 から分岐）",
  );
  await newChat(page);
  await list
    .locator("li:not(:has(li))")
    .filter({ hasText: "分岐の設計案は？" })
    .click();
  await expect(branchSelect.locator("option:checked")).toHaveText(
    "非同期だと？（元の会話 から分岐）",
  );
});

/** 最後の回答の最初の段落を選択する（マウス・タッチ・キーボードでの選択の代わり）。 */
const selectAnswerParagraph = (answer: Locator) =>
  answer
    .locator("p")
    .first()
    .evaluate((paragraph) => {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });

const selectLastAnswerParagraph = (page: Page) =>
  selectAnswerParagraph(page.locator("[data-assistant-message]").last());

test("回答の選択範囲を引用して質問すると、引用付きの分岐ができる", async ({
  page,
}) => {
  await open(page);
  const main = page.getByRole("region", { name: "メインのチャット" });
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const sideInput = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  const popup = main.getByRole("toolbar", { name: "選択範囲の操作" });
  const ask = popup.getByRole("button", { name: "質問", exact: true });

  // 用語ページのあるタスクで、用語の説明と選択による質問を使い分ける
  await createTask(page, "引用の検証");
  await openWiki(page, "引用の検証");
  await page.getByRole("button", { name: "新しいページ" }).click();
  await page.getByRole("textbox", { name: "ページのタイトル" }).fill("方式B");
  await page
    .getByRole("textbox", { name: "本文（Markdown）" })
    .fill("非同期で処理する方式。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await openTask(page, "引用の検証");
  await newChat(page);
  await send(page, "方式A と 方式B の比較");
  await idle(page);
  const chatUrl = page.url();
  const mainInput = main.getByRole("textbox", {
    name: "メッセージ",
    exact: true,
  });
  await mainInput.fill("メインの続き");
  // 末尾を現在地にしても、次の送信先はこの分岐のまま。
  await main.getByRole("button", { name: "ここから分岐" }).click();
  await expect(
    main.getByText("この応答の続きとして分岐を作ります。"),
  ).toHaveCount(0);
  await expect(ask).toHaveCount(0);

  // 用語はクリックで右側のペインに開く（選択してもペインは開かない）
  const term = main.locator("button[data-wiki-term]").last();
  const wikiPane = page.getByRole("complementary", { name: "Wiki ページ" });
  await term.click();
  await expect(wikiPane).toContainText("非同期で処理する方式。");
  await page.keyboard.press("Escape");
  await expect(wikiPane).toHaveCount(0);
  await mainInput.hover();
  await expect(page.getByRole("dialog", { name: "用語の説明" })).toHaveCount(0);

  // 選択すると、選択範囲のすぐ近くにポップアップが出る
  await selectLastAnswerParagraph(page);
  await expect(ask).toBeVisible();
  const selected = await page.evaluate(() => {
    const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    return rect === undefined
      ? null
      : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const box = await popup.boundingBox();
  expect(selected).not.toBeNull();
  expect(box).not.toBeNull();
  if (selected !== null && box !== null) {
    // 選択範囲の上（余白が無ければ下）に、離れずに出る
    const gap =
      box.y + box.height <= selected.y
        ? selected.y - (box.y + box.height)
        : box.y - (selected.y + selected.height);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(24);
  }

  // 初回送信前に閉じると分岐はできない。メインの入力も残る。
  await ask.click();
  await expect(popup).toHaveCount(0);
  await expect(side.locator("blockquote")).toContainText(
    "方式A と 方式B の比較",
  );
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();
  await expect(mainInput).toBeFocused();
  await expect(mainInput).toHaveValue("メインの続き");
  await expect(page.getByRole("combobox", { name: "分岐" })).toHaveCount(0);

  // 送ると、引用付きの分岐ができ、モデルには引用と質問が区別して届く
  await selectLastAnswerParagraph(page);
  await ask.click();
  await sideInput.fill("失敗時はどう復旧する？");
  await sideInput.press("Enter");
  await expect(
    side.getByText(/了解: 以下は、直前までの回答から利用者が選んだ引用です/),
  ).toBeVisible();
  await expect(
    side.getByText(
      /利用者が選んだ引用です[\s\S]*方式A と 方式B の比較[\s\S]*失敗時はどう復旧する？/,
    ),
  ).toBeVisible();
  await expect(page).toHaveURL(chatUrl);
  await expect(mainInput).toHaveValue("メインの続き");
  await mainInput.press("Enter");
  await expect(main.getByText("了解: メインの続き")).toBeVisible();
  await expect(page).toHaveURL(chatUrl);

  // 2 ターン目と承認操作もサイドの分岐へ届く。
  await side.getByRole("button", { name: "送信", exact: true }).waitFor();
  await sideInput.fill("承認が必要な操作をして");
  await sideInput.press("Enter");
  await side
    .getByRole("region", { name: "ツール実行の承認" })
    .getByRole("button", { name: "許可" })
    .click();
  await expect(side.getByText("許可されました", { exact: true })).toBeVisible();
  await expect(main.getByText("許可されました", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("combobox", { name: "分岐" })).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "分岐" }).locator("option"),
  ).toHaveCount(2);
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();
  await expect(side).toHaveCount(0);

  // リロードしても引用と質問が残り、元の会話もそのまま
  await page.reload();
  const branches = page.getByRole("combobox", { name: "分岐" });
  await expect(branches.locator("option:checked")).toHaveText("元の会話");
  await branches.selectOption({
    label: "失敗時はどう復旧する？（元の会話 から分岐）",
  });
  await expect(main.locator("blockquote").first()).toContainText(
    "方式A と 方式B の比較",
  );
  await expect(
    main.getByText("失敗時はどう復旧する？", { exact: true }).first(),
  ).toBeVisible();
  await branches.selectOption({ label: "元の会話" });
  await expect(main.locator("blockquote")).toHaveCount(0);
});

test("保存済みの分岐をサイドで開き直し、メインの現在地を保って続けられる", async ({
  page,
}, testInfo) => {
  await open(page);
  await newChat(page);
  const main = page.getByRole("region", { name: "メインのチャット" });
  const mainInput = main.getByRole("textbox", {
    name: "メッセージ",
    exact: true,
  });
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const sideInput = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  const sideAnswers = side.locator("[data-assistant-message]");
  const closeSideButton = side.getByRole("button", {
    name: "サイドチャットを閉じる",
  });
  // 閉じるとメインの入力欄にフォーカスが戻る（次の描画で）。戻るのを待たずに次の操作をすると、
  // キー入力がメインの入力欄に入ってしまう
  const closeSide = {
    click: async () => {
      await closeSideButton.click();
      await expect(mainInput).toBeFocused();
    },
  };
  const branchSelect = main.getByRole("combobox", { name: "分岐" });
  const openSavedBranch = async () => {
    await main.getByText("サイドで開く", { exact: true }).press("Enter");
    await main
      .getByRole("list", { name: "サイドで開く分岐" })
      .getByRole("button", { name: "あとで再開する質問（元の会話 から分岐）" })
      .click();
  };

  const firstQuestion = `保存分岐の起点 ${testInfo.repeatEachIndex}`;
  await send(page, firstQuestion);
  await expect(main.getByText(`了解: ${firstQuestion}`)).toBeVisible();
  await idle(page);
  const rootUrl = page.url();
  await selectLastAnswerParagraph(page);
  await main.getByRole("button", { name: "質問", exact: true }).click();
  await sideInput.fill("あとで再開する質問");
  await sideInput.press("Enter");
  await expect(
    sideAnswers.getByText("あとで再開する質問", { exact: true }),
  ).toBeVisible();
  await closeSide.click();
  await send(page, "元の会話で進めた話題");
  await expect(main.getByText("了解: 元の会話で進めた話題")).toBeVisible();
  await idle(page);

  await page.reload();
  await expect(branchSelect.locator("option:checked")).toHaveText("元の会話");
  await main.getByRole("button", { name: "回答を開く" }).click();
  await main.getByRole("button", { name: "ここから分岐" }).first().click();
  await mainInput.fill("メインで編集中の下書き");

  await openSavedBranch();
  await expect(
    sideAnswers.getByText("あとで再開する質問", { exact: true }),
  ).toBeVisible();
  await expect(mainInput).toHaveValue("メインで編集中の下書き");
  await expect(branchSelect).toBeDisabled();
  await expect(page).toHaveURL(rootUrl);
  await sideInput.fill("承認が必要な操作をして");
  await sideInput.press("Enter");
  const approval = side.getByRole("region", { name: "ツール実行の承認" });
  await expect(approval).toBeVisible();

  // 承認待ちの分岐を閉じてから開き直しても、同じ分岐の生成に戻れる。
  await closeSide.click();
  await openSavedBranch();
  await approval.getByRole("button", { name: "許可" }).click();
  await expect(
    sideAnswers.getByText("許可されました", { exact: true }),
  ).toBeVisible();
  await closeSide.click();
  await expect(mainInput).toHaveValue("メインで編集中の下書き");
  await expect(
    main.getByText("この応答の続きとして分岐を作ります。"),
  ).toBeVisible();
  await expect(branchSelect.locator("option")).toHaveCount(2);
  await expect(page).toHaveURL(rootUrl);

  await newChat(page);
  await page
    .getByRole("navigation", { name: "会話一覧" })
    .getByText(firstQuestion, { exact: true })
    .click();
  await expect(page).toHaveURL(rootUrl);
  await expect(main.getByText("了解: 元の会話で進めた話題")).toBeVisible();
});

test("過去の回答をサイドで質問し、狭い画面でもメインの現在地と下書きを保つ", async ({
  page,
}) => {
  await open(page);
  await newChat(page);
  const main = page.getByRole("region", { name: "メインのチャット" });
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const mainInput = main.getByRole("textbox", {
    name: "メッセージ",
    exact: true,
  });
  await send(page, "回答の起点 A");
  await expect(main.getByText("了解: 回答の起点 A")).toBeVisible();
  await idle(page);
  await send(page, "メインの続き B");
  await expect(main.getByText("了解: メインの続き B")).toBeVisible();
  await idle(page);
  await mainInput.fill("B からの続き C");

  await main.getByRole("button", { name: "回答を開く" }).click();
  await selectAnswerParagraph(main.locator("[data-assistant-message]").first());
  await main.getByRole("button", { name: "質問", exact: true }).click();
  await expect(side.locator("blockquote")).toContainText("回答の起点 A");
  await expect(main.getByText("了解: メインの続き B")).toBeVisible();
  await page.setViewportSize({ width: 700, height: 740 });
  await expect(side).toBeVisible();
  await expect(main).toBeHidden();
  expect((await side.boundingBox())?.width).toBe(700);
  const input = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  await input.fill("A からの脇道");
  await input.press("Enter");
  const sideAnswers = side.locator("[data-assistant-message]");
  await expect(
    sideAnswers.getByText("A からの脇道", { exact: true }),
  ).toBeVisible();
  await expect(side.getByText("メインの続き B", { exact: true })).toHaveCount(
    0,
  );
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();
  await expect(mainInput).toHaveValue("B からの続き C");
  await mainInput.press("Enter");
  await expect(main.getByText("了解: B からの続き C")).toBeVisible();
  await expect(main.getByText("メインの続き B", { exact: true })).toBeVisible();
  await expect(main.getByText("A からの脇道", { exact: true })).toHaveCount(0);

  // メインとサイドが同じ過去の現在地から分岐しても、パネルは切り替わらない。
  await page.setViewportSize({ width: 1280, height: 800 });
  await idle(page);
  const rootUrl = page.url();
  await main.getByRole("button", { name: "ここから分岐" }).first().click();
  await selectAnswerParagraph(main.locator("[data-assistant-message]").first());
  await main.getByRole("button", { name: "質問", exact: true }).click();
  await input.fill("A の別の脇道");
  await input.press("Enter");
  const sideAnswer = sideAnswers.getByText("A の別の脇道", { exact: true });
  await expect(sideAnswer).toBeVisible();
  await expect(
    main.getByText("この応答の続きとして分岐を作ります。"),
  ).toBeVisible();
  await send(page, "A からメインで分岐");
  await expect(main.getByText("了解: A からメインで分岐")).toBeVisible();
  expect(page.url()).not.toBe(rootUrl);
  await expect(sideAnswer).toBeVisible();
});

test("生成中に予約したメッセージは回答のあとに順に送られ、停止すると一時停止する", async ({
  page,
}) => {
  await open(page);
  await newChat(page);
  const panel = page.getByRole("region", { name: "予約したメッセージ" });

  // 生成中に Enter で予約する（割り込まない）
  await send(page, "ゆっくり数えて");
  await expect(page.locator("main")).toContainText("2");
  await send(page, "予約その1");
  await send(page, "予約その2");
  await expect(panel).toContainText("予約 2 件");
  await expect(panel).toContainText("予約その1");
  await expect(page.getByText("了解: 予約その2")).toBeVisible({
    timeout: 20_000,
  });
  await expect(panel).toHaveCount(0);
  await idle(page);
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text.indexOf("40")).toBeLessThan(text.indexOf("了解: 予約その1"));
  expect(text.indexOf("了解: 予約その1")).toBeLessThan(
    text.indexOf("予約その2"),
  );

  // 停止すると予約は送らずに一時停止する。リロードしても残る
  await send(page, "もう一度ゆっくり数えて");
  await expect(page.getByRole("button", { name: "停止" })).toBeVisible();
  await send(page, "止めたあと");
  await expect(panel).toContainText("予約 1 件");
  await page.getByRole("button", { name: "停止" }).click();
  await expect(panel).toContainText("一時停止中");
  await page.reload();
  await expect(panel).toContainText("一時停止中");
  await expect(page.getByText("了解: 止めたあと")).toHaveCount(0);

  // 書き換えてから再開する
  await panel.getByRole("button", { name: "予約を編集" }).click();
  await panel
    .getByRole("textbox", { name: "予約を編集" })
    .fill("書き換えた予約");
  await panel.getByRole("button", { name: "保存" }).click();
  await expect(panel).toContainText("書き換えた予約");
  await panel.getByRole("button", { name: "再開" }).click();
  await expect(page.getByText("了解: 書き換えた予約")).toBeVisible({
    timeout: 15_000,
  });
  await expect(panel).toHaveCount(0);
  await idle(page);
  await expect(page.getByText("了解: 止めたあと")).toHaveCount(0);
});

test("プロンプトキャッシュの推定残り時間を表示し、モデルを変えると不明になる", async ({
  page,
}) => {
  await open(page);
  await newChat(page);
  const cache = page.getByTestId("prompt-cache");
  await expect(cache).toHaveCount(0);
  await send(page, "キャッシュ");
  await idle(page);
  await expect(cache).toHaveText(/キャッシュ 残り約 (59|60):\d\d/);
  const first = await cache.textContent();
  await expect(cache).not.toHaveText(first ?? "", { timeout: 3_000 });

  // 期限は時刻で持つので、リロードしても数え直す
  await page.reload();
  await expect(cache).toHaveText(/キャッシュ 残り約 (59|60):\d\d/);

  await page.getByRole("combobox", { name: "モデル" }).selectOption("haiku");
  await expect(cache).toHaveText("キャッシュ 不明");
});

test("会話をタイトルと本文で検索し、一致した発言へ移動できる", async ({
  page,
}) => {
  await open(page);
  await newChat(page);
  await send(page, "ミトコンドリアについて教えて");
  await idle(page);
  await send(page, "細胞小器官の一覧も");
  await idle(page);
  await send(page, "最後に要点をまとめて");
  await idle(page);
  await newChat(page);
  await send(page, "別の話題");
  await idle(page);

  // 検索はアイコンだけで、押すと入力欄が広がる
  const box = page.getByRole("searchbox", { name: "会話を検索" });
  const results = page.getByRole("navigation", { name: "会話の検索結果" });
  await expect(box).toBeHidden();
  await page.getByRole("button", { name: "会話を検索" }).click();
  await expect(box).toBeFocused();
  await box.fill("小器官");
  // ユーザー発言と、それを繰り返す回答
  await expect(results.locator("mark", { hasText: "小器官" })).toHaveCount(2);
  await expect(page.getByRole("navigation", { name: "会話一覧" })).toBeHidden();
  await results
    .getByRole("button", { name: /回答.*了解: 細胞小器官の一覧も/ })
    .click();
  await expect(
    page.getByRole("main").getByText("了解: 細胞小器官の一覧も"),
  ).toBeVisible();
  await expect(
    page
      .locator("[data-message-id]")
      .filter({ hasText: "了解: 細胞小器官の一覧も" }),
  ).toHaveClass(/ring-2/);

  // タイトルも対象。ひらがなとカタカナは区別する
  await box.fill("みとこんどりあ");
  await expect(results).toContainText("見つかりませんでした。");
  await box.fill("ミトコンドリア");
  await expect(
    results
      .getByRole("button", { name: "ミトコンドリアについて教えて" })
      .first(),
  ).toBeVisible();

  // Escape で一覧に戻り、アイコンに畳む
  await box.press("Escape");
  await expect(
    page.getByRole("navigation", { name: "会話一覧" }),
  ).toBeVisible();
  await expect(box).toBeHidden();
  await expect(page.getByRole("button", { name: "会話を検索" })).toBeFocused();
});

test("回答のあとに、サブスクリプションの利用枠とリセット時刻をヘッダーに出す", async ({
  page,
}) => {
  await open(page);
  await newChat(page);
  await send(page, "利用枠");
  await idle(page);
  const badge = page.getByTestId("rate-limit");
  await expect(badge).toHaveText(/7 日間枠 67%・\d+\/\d+ \d+:\d\d にリセット/);
  await expect(badge).toHaveAttribute("title", /5 時間枠: 62%/);
});

/** 回答の中の text と一致する文字だけを選ぶ。 */
const selectAnswerText = (answer: Locator, text: string) =>
  answer.evaluate((root, target) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (
      let node = walker.nextNode();
      node !== null;
      node = walker.nextNode()
    ) {
      const at = node.textContent?.indexOf(target) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + target.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    throw new Error(`text not found: ${target}`);
  }, text);

test("回答の選択範囲から AI で Wiki のページを作り、チャットに留まったまま用語として表示する", async ({
  page,
}) => {
  await open(page);
  const main = page.getByRole("main");
  const popup = main.getByRole("toolbar", { name: "選択範囲の操作" });
  const createPage = popup.getByRole("button", { name: "ページを作成" });
  const lastAnswer = page.locator("[data-assistant-message]").last();

  // タスクに属さない会話では押せない
  await newChat(page);
  await send(page, "分散トランザクション");
  await idle(page);
  await selectLastAnswerParagraph(page);
  await expect(createPage).toBeDisabled();

  await createTask(page, "ページ作成の検証");
  await newChat(page);
  await send(page, "冪等性キーの使い方");
  await expect(main.getByText("了解: 冪等性キーの使い方")).toBeVisible();
  await idle(page);
  const chatPath = new URL(page.url()).pathname;
  const messageInput = main.getByRole("textbox", {
    name: "メッセージ",
    exact: true,
  });
  await messageInput.fill("まだ送っていない質問");

  // 語句を選んで作ると、画面を移らずに生成中の表示になり、できたら用語になる
  await selectAnswerText(lastAnswer, "冪等性キー");
  await createPage.click();
  const generating = main.locator("[data-wiki-term-pending]", {
    hasText: "冪等性キー",
  });
  await expect(generating).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${chatPath}$`));
  const term = main.locator("button[data-wiki-term]", {
    hasText: "冪等性キー",
  });
  await expect(term).toBeVisible();
  await expect(generating).toHaveCount(0);
  await expect(messageInput).toHaveValue("まだ送っていない質問");
  // 用語をクリックすると、作ったページが右側のペインで開く
  await term.click();
  const pane = page.getByRole("complementary", { name: "Wiki ページ" });
  await expect(pane).toContainText("冪等性キー は回答に出てきた語。");
  await pane.getByRole("button", { name: "Wiki ページを閉じる" }).click();
  await expect(pane).toHaveCount(0);

  // 同じ名前のページがあれば、作らずに知らせる
  await selectAnswerText(lastAnswer, "冪等性キー");
  await createPage.click();
  await expect(
    main.getByRole("status").filter({
      hasText: "「冪等性キー」のページはすでにあります。",
    }),
  ).toBeVisible();

  // 生成に失敗したら、生成中の表示を消してエラーを出す
  await send(page, "失敗する語句");
  await expect(main.getByText("了解: 失敗する語句")).toBeVisible();
  await idle(page);
  await selectAnswerText(lastAnswer, "失敗する語句");
  await createPage.click();
  await expect(
    main.getByRole("alert").filter({
      hasText: "「失敗する語句」のページを作成できませんでした。",
    }),
  ).toBeVisible();
  await expect(main.locator("[data-wiki-term-pending]")).toHaveCount(0);
  await expect(
    main.locator("button[data-wiki-term]", { hasText: "失敗する語句" }),
  ).toHaveCount(0);

  // 作ったページは Wiki に、元の回答から自動で作成したページとして載っている
  await openWiki(page, "ページ作成の検証");
  await page.getByRole("button", { name: "冪等性キー", exact: true }).click();
  await expect(page.getByRole("heading", { name: "冪等性キー" })).toBeVisible();
  await expect(
    page.getByText("回答から自動で作成したページです"),
  ).toBeVisible();
  await expect(page.getByText("生成したページ。")).toBeVisible();
});

test("Wiki の個別ページで質問し、リロードやページ削除のあとも履歴を開ける", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "ページ質問の検証");
  await openWiki(page, "ページ質問の検証");
  await page.getByRole("button", { name: "新しいページ" }).click();
  const title = "委譲手順";
  await page.getByRole("textbox", { name: "ページのタイトル" }).fill(title);
  await page
    .getByRole("textbox", { name: "本文（Markdown）" })
    .fill("管理者に確認する。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const url = page.url();

  const ask = page.getByRole("button", { name: "このページについて質問" });
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const composer = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  const close = side.getByRole("button", { name: "サイドチャットを閉じる" });
  const send = async (text: string) => {
    await composer.fill(text);
    await composer.press("Enter");
  };
  await ask.click();
  await expect(side.getByText(title, { exact: true })).toBeVisible();
  await expect(
    page.getByText("管理者に確認する。", { exact: true }),
  ).toBeVisible();
  await send("要約して");
  await expect(side.locator("a[data-wiki-page]:visible")).toHaveText(title);
  await expect(page).toHaveURL(url);
  await close.click();
  await expect(ask).toBeFocused();

  await page.reload();
  await ask.click();
  await expect(side.locator("a[data-wiki-page]:visible")).toHaveText(title);
  await send("具体的には？");
  await expect(side.getByText("具体的には？", { exact: true })).toBeVisible();
  await expect(side.locator("a[data-wiki-page]:visible")).toHaveText(title);
  await expect(side.getByRole("button", { name: "回答を開く" })).toBeVisible();

  await page.getByRole("button", { name: "ページを削除" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "削除", exact: true })
    .click();
  await expect(
    page.getByText("このページは削除されたか、存在しません。"),
  ).toBeVisible();
  await close.click();
  await page.reload();
  await page.getByRole("button", { name: "質問の履歴を開く" }).click();
  await expect(side.getByText("具体的には？", { exact: true })).toBeVisible();
  await send("削除後の質問");
  await expect(side.getByRole("alert")).toContainText(
    "この Wiki ページを参照できません",
  );
});

test("環境のタスクは Wiki を共有し、サイドバーで環境ごとにまとまる", async ({
  page,
}) => {
  await open(page);
  const taskNames = (environment: string) =>
    environmentItem(page, environment).locator(
      "li div.group > button[aria-expanded]",
    );

  // 1 つ目は新しい環境で作り、Wiki にページを書く
  await createTask(page, "共有元");
  await openWiki(page, "共有元");
  await page.getByRole("button", { name: "新しいページ" }).click();
  await page
    .getByRole("textbox", { name: "ページのタイトル" })
    .fill("共有用語");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "共有用語" })).toBeVisible();

  // 2 つ目は環境の行から作ると、その環境に入る
  await rowAction(
    environmentRow(page, "共有元"),
    "環境「共有元」に新しいタスク",
  );
  await page.getByRole("textbox", { name: "タスクの名前" }).fill("共有先");
  await expect(
    page
      .getByRole("combobox", { name: "タスクの環境" })
      .locator("option:checked"),
  ).toHaveText("共有元");
  await page.getByRole("button", { name: "作成" }).click();
  await expect(taskNames("共有元")).toHaveText(["共有元", "共有先"]);

  // 同じページが見え、共有していることが分かる
  await openWiki(page, "共有元");
  await expect(
    page.getByText("「共有先」と共有している Wiki です"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "共有用語" })).toBeVisible();

  // 3 つ目は別の環境になる
  await createTask(page, "別の環境");
  await expect(taskNames("別の環境")).toHaveText(["別の環境"]);

  // まとめるのをやめると、タスクが環境の下ではなく平らに並ぶ（リロードしても保たれる）
  const groupToggle = page.getByRole("button", { name: "環境ごとにまとめる" });
  await expect(groupToggle).toHaveAttribute("aria-pressed", "true");
  await groupToggle.click();
  await expect(groupToggle).toHaveAttribute("aria-pressed", "false");
  await expect(environmentRow(page, "共有元")).toHaveCount(0);
  for (const name of ["共有元", "共有先", "別の環境"]) {
    await expect(
      sidebarTree(page)
        .locator(":scope > ul > li[data-task-id]")
        .filter({ has: rowMatching(page, `「${name}」の概要を開く`) }),
    ).toHaveCount(1);
  }
  await page.reload();
  await expect(groupToggle).toHaveAttribute("aria-pressed", "false");
  await expect(taskRow(page, "共有先")).toBeVisible();
  await groupToggle.click();
  await expect(taskNames("共有元")).toHaveText(["共有元", "共有先"]);

  // 環境の行を押すと、その下のタスクを開閉する（リロードしても保たれる）
  const sharedToggle = environmentRow(page, "共有元").locator(
    ":scope > button[aria-expanded]",
  );
  await sharedToggle.click();
  await expect(taskRow(page, "共有先")).toHaveCount(0);
  await page.reload();
  await expect(sharedToggle).toHaveAttribute("aria-expanded", "false");
  await sharedToggle.click();
  await expect(taskNames("共有元")).toHaveText(["共有元", "共有先"]);

  // 環境の設定: 無いディレクトリは保存できない。フォルダを選んで追加し、名前と Wiki の名前を変える
  await openEnvironmentMenu(page, "共有元", "環境の設定");
  const settings = page.getByRole("dialog", { name: "環境の設定" });
  const directories = settings.getByRole("list", {
    name: "環境のディレクトリ",
  });
  await expect(directories.locator("[data-directory]")).toHaveAttribute(
    "data-directory",
    "/e2e",
  );
  await settings.getByRole("button", { name: "/e2e を外す" }).click();
  await settings
    .getByRole("textbox", { name: "追加するディレクトリのパス" })
    .fill("/no/such/directory");
  await settings.getByRole("button", { name: "追加", exact: true }).click();
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect(settings.getByRole("alert")).toContainText(
    "ディレクトリが見つかりません: /no/such/directory",
  );
  await settings
    .getByRole("button", { name: "/no/such/directory を外す" })
    .click();
  await settings.getByRole("button", { name: "選ぶ" }).click();
  await expect(directories.getByRole("listitem")).toHaveCount(1);
  const picked =
    (await directories
      .locator("[data-directory]")
      .first()
      .getAttribute("data-directory")) ?? "";
  expect(picked).not.toBe("");
  await settings.getByRole("textbox", { name: "環境の名前" }).fill("共通環境");
  await settings
    .getByRole("textbox", { name: "Wiki の名前" })
    .fill("共通用語集");
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(taskNames("共通環境")).toHaveText(["共有元", "共有先"]);
  await openWiki(page, "共通環境");
  await expect(page.locator("main header")).toContainText("Wiki: 共通用語集");

  // 環境のスレッドは、選んだディレクトリで動く
  await rowAction(taskRow(page, "共有先"), "「共有先」に新しいスレッド");
  await expect(page).toHaveURL(/\/c\/.+/);
  await expect(
    page
      .getByRole("region", { name: "メインのチャット" })
      .locator(`[title="${picked}"]`),
  ).toBeVisible();

  // タスクを別の環境に移すと、その環境の下に移る
  await openTaskMenu(page, "共有先", "タスクの設定");
  await page
    .getByRole("combobox", { name: "タスクの環境" })
    .selectOption({ label: "別の環境" });
  await page.getByRole("button", { name: "閉じる" }).click();
  await expect(taskNames("別の環境")).toHaveText(["共有先", "別の環境"]);
  await expect(taskNames("共通環境")).toHaveText(["共有元"]);

  // タスクのある環境は消せない。タスクを消すと消せて、Wiki もページごと消える
  await openEnvironmentMenu(page, "共通環境", "環境を削除");
  await expect(
    page.getByRole("dialog", { name: "この環境は削除できません" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "閉じる" }).click();
  await openTaskMenu(page, "共有元", "タスクを削除");
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await expect(taskRow(page, "共有元")).toHaveCount(0);
  await expect(
    environmentItem(page, "共通環境").getByText("まだタスクがありません。"),
  ).toBeVisible();
  await openEnvironmentMenu(page, "共通環境", "環境を削除");
  await expect(
    page.getByText("Wiki「共通用語集」とそのページも削除されます。", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await expect(environmentRow(page, "共通環境")).toHaveCount(0);
});

test("サイドバーをボタンと ⌘B（Ctrl+B）で畳んで開け、リロードしても保たれる", async ({
  page,
}) => {
  await open(page);
  const sidebar = page.getByRole("complementary", { name: "サイドバー" });
  await expect(sidebar).toBeVisible();
  await page.getByRole("button", { name: "サイドバーを閉じる" }).click();
  await expect(sidebar).toBeHidden();
  const reopen = page.getByRole("button", { name: "サイドバーを開く" });
  await expect(reopen).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(sidebar).toBeHidden();
  await page.keyboard.press("ControlOrMeta+B");
  await expect(sidebar).toBeVisible();

  // 入力欄で書いている途中でも効き、ヘッダーに開いている会話の名前が出る
  await newChat(page);
  await expect(page.getByRole("main").locator("header")).toContainText(
    "新しい会話",
  );
  const box = page.getByRole("textbox", { name: "メッセージ", exact: true });
  await box.fill("下書き");
  await box.press("ControlOrMeta+B");
  await expect(sidebar).toBeHidden();
  await expect(box).toHaveValue("下書き");
  await box.press("ControlOrMeta+B");
  await expect(sidebar).toBeVisible();
});
