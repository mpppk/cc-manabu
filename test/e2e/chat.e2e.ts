import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

const TOKEN = "e2e-token";

const open = async (page: Page) => {
  await page.goto(`/#token=${TOKEN}`);
  await expect(page.locator('main[data-claude-state="ready"]')).toBeVisible();
};

/**
 * 今開いている画面のタスク（無ければ未所属）に、サイドバーの行の操作で新しいスレッドを作る。
 * タスクの概要・Wiki（`/t/<id>`）ならそのタスク、スレッドならその所属先。
 */
const newChat = async (page: Page) => {
  const before = page.url();
  const path = new URL(before).pathname;
  const tree = page.getByRole("navigation", { name: "スレッド一覧" });
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

/** モデル選択のボタン（#183）。`data-model` に選択中のモデル ID を持つ。 */
const modelButton = (scope: Page | Locator) =>
  scope.getByRole("button", { name: /^モデル: / });

/** モデルを選ぶ。最初の階層に無ければ「その他のモデル」から選ぶ。 */
const pickModel = async (scope: Page | Locator, name: string) => {
  await modelButton(scope).click();
  const menu = scope.getByRole("menu", { name: "モデル", exact: true });
  const item = menu.getByRole("menuitemradio", { name, exact: true });
  if ((await item.count()) === 0) {
    await menu.getByRole("menuitem", { name: "その他のモデル" }).click();
  }
  await item.click();
};

const idle = (page: Page) =>
  expect(page.getByRole("button", { name: "送信", exact: true })).toBeVisible({
    timeout: 15_000,
  });

test("トークンを URL から消し、送信した発話に回答がストリーミングされる", async ({
  page,
}) => {
  await open(page);
  await expect(page).not.toHaveURL(/token=/);
  await newChat(page);
  await send(page, "こんにちは");
  await expect(page.getByText("了解: こんにちは")).toBeVisible();
  await idle(page);
  // 使用量とタイトル。入出力トークン数は出さない（#184）
  await expect(page.getByText(/\$0\.0010・/).first()).toBeVisible();
  await expect(page.getByText(/トークン/)).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation", { name: "スレッド一覧" })
      .getByText("こんにちは"),
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
  await expect(page.locator('main[data-claude-state="ready"]')).toBeVisible();
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
      .getByText(/\$0\.0010・/),
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
  await expect(page).toHaveTitle("monet");

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
  // 入力欄の下の利用枠のリセット時刻（例: 10:40）にも数字が出るので、回答の中だけを見る
  await expect(
    chat.locator("[data-assistant-message]").last(),
  ).not.toContainText("40");

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

test("スレッドの切り替え・名前変更・削除", async ({ page }) => {
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

  const list = page.getByRole("navigation", { name: "スレッド一覧" });
  await list.getByText("一つ目の会話").click();
  await expect(firstAnswer).toBeVisible();

  const item = list
    .locator("li:not(:has(li))")
    .filter({ hasText: "一つ目の会話" });
  await item.hover();
  await item.getByRole("button", { name: /の名前を変える/ }).click();
  await page
    .getByRole("textbox", { name: "スレッドの名前" })
    .fill("名前を変えた");
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
    page.getByRole("navigation", { name: "スレッド一覧" }).getByText("画像", {
      exact: true,
    }),
  ).toBeVisible();
});

/** サイドバーのツリー（環境 → タスク → スレッド）。 */
const sidebarTree = (page: Page) =>
  page.getByRole("navigation", { name: "スレッド一覧" });

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

/** 画面上部のヘッダーにある、会話の切り替え（#234）。 */
const branchMenu = (page: Page) => {
  const trigger = page.getByRole("button", { name: "会話を切り替える" });
  const popup = page.getByRole("dialog", { name: "会話" });
  const rows = popup.locator("button[data-branch-row]");
  const open = async () => {
    if (!(await popup.isVisible())) await trigger.click();
    await expect(popup).toBeVisible();
  };
  const close = async () => {
    if (await popup.isVisible()) await popup.press("Escape");
    await expect(popup).toHaveCount(0);
  };
  return {
    trigger,
    popup,
    open,
    close,
    /** 会話の名前（作った順）。分岐した会話は「名前（分岐元 から分岐）」。 */
    expectLabels: async (labels: string[]) => {
      await open();
      await expect
        .poll(() =>
          rows.evaluateAll((buttons) =>
            buttons.map((button) => button.getAttribute("aria-label")),
          ),
        )
        .toEqual(labels);
      await close();
    },
    expectCount: async (count: number) => {
      await open();
      await expect(rows).toHaveCount(count);
      await close();
    },
    /** 開いている会話。 */
    expectCurrent: async (label: string) => {
      await open();
      await expect(
        popup.locator('button[data-branch-row][aria-current="true"]'),
      ).toHaveAttribute("aria-label", label);
      await close();
    },
    select: async (label: string) => {
      await open();
      await popup.getByRole("button", { name: label, exact: true }).click();
      await expect(popup).toHaveCount(0);
    },
    /** メインはそのままで、サイドで開く。name は分岐元を含まない会話の名前。 */
    openSide: async (name: string) => {
      await open();
      await popup
        .getByRole("button", { name: `「${name}」をサイドで開く` })
        .click();
      await expect(popup).toHaveCount(0);
    },
  };
};

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

/** タスク一覧のカンバンの列（#195）。 */
const column = (page: Page, label: string) =>
  page.getByRole("region", { name: new RegExp(`^${label}`) });

/** タスク一覧のカンバンのカード（#195）。 */
const card = (page: Page, name: string) =>
  page
    .locator("[data-task-card]")
    .filter({ has: page.getByRole("button", { name, exact: true }) });

test("何も送っていないスレッドは開いている間だけ出て、＋で使い回す", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "下書き置き場");
  const item = taskItem(page, "下書き置き場");
  await newChat(page);
  const blank = page.url();
  await expect(item.getByText("新しいスレッド", { exact: true })).toBeVisible();

  // 別の画面に移ると、空のスレッドは一覧から消える
  await page
    .getByRole("button", { name: "「下書き置き場」の概要を開く" })
    .click();
  await expect(page).toHaveURL(/\/t\/.+/);
  await expect(item.getByText("新しいスレッド", { exact: true })).toHaveCount(
    0,
  );
  await expect(item.getByText("まだスレッドがありません。")).toBeVisible();

  // ＋を押すと、同じ空のスレッドを開く
  await newChat(page);
  expect(page.url()).toBe(blank);

  // 送ればタイトルが付き、離れても一覧に残る
  await send(page, "残るスレッド");
  await idle(page);
  await page
    .getByRole("button", { name: "「下書き置き場」の概要を開く" })
    .click();
  await expect(item.getByText("残るスレッド")).toBeVisible();
  await newChat(page);
  expect(page.url()).not.toBe(blank);
});

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
  await page.getByRole("button", { name: "新しいノート" }).click();
  await page
    .getByRole("textbox", { name: "ノートのタイトル" })
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
  const wikiPages = page.getByRole("list", { name: "ノート" });
  await expect(
    wikiPages.getByRole("button", { name: /関係タプル/ }),
  ).toHaveAttribute("aria-current", "page");

  // 一覧の検索
  await page.getByRole("textbox", { name: "Wiki を検索" }).fill("タプル");
  await expect(wikiPages.getByText("関係タプル")).toBeVisible();
  await page.getByRole("textbox", { name: "Wiki を検索" }).fill("存在しない語");
  await expect(page.getByText("一致するノートはありません。")).toBeVisible();

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
  const pane = page.getByRole("complementary", { name: "ノート" });
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
  await page.getByRole("button", { name: "ノートを削除" }).click();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.getByText("まだノートがありません。")).toBeVisible();
  await openTask(page, "Wiki の検証");
  await taskItem(page, "Wiki の検証").getByText("関係タプルって何？").click();
  await expect(page.getByText(/参照: .*関係タプル/)).toBeVisible();
  await page.getByRole("main").locator("a[data-wiki-page]").click();
  await expect(
    pane.getByText("このノートは削除されたか、存在しません。"),
  ).toBeVisible();
});

test("回答から用語ノートが自動で作られ、編集を保ち、設定で止められる", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "用語の検証");
  const wikiPages = page.getByRole("list", { name: "ノート" });
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
    .getByRole("navigation", { name: "スレッド一覧" })
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
    name: /回答から用語ノートを自動で作る/,
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
  await page.getByRole("button", { name: "Wiki の概要" }).click();
  await expect(page.getByRole("dialog", { name: "Wiki の概要" })).toContainText(
    "回答からの用語ノートの自動作成: オフ",
  );
  await page.keyboard.press("Escape");
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
    await page.getByRole("button", { name: "新しいノート" }).click();
    await page.getByRole("textbox", { name: "ノートのタイトル" }).fill(title);
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

  // キーボード: フォーカスで要約、Tab で要約の「サイドパネルで開く」へ移って本文を開き（#168）、
  // サイドパネルの「Wiki で開く」で Wiki 画面へ移る
  const chatUrl = page.url();
  await terms.nth(1).focus();
  await expect(card).toBeVisible();
  // 要約は読み込んでから出るので、ボタンが出てから Tab で移る
  const openInPane = card.getByRole("button", { name: "サイドパネルで開く" });
  await expect(openInPane).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(openInPane).toBeFocused();
  await page.keyboard.press("Enter");
  const termPane = page.getByRole("complementary", { name: "ノート" });
  await expect(termPane).toContainText("主体・関係・対象の 3 つ組。");
  await expect(card).toHaveCount(0);
  expect(page.url()).toBe(chatUrl);
  await termPane.getByRole("button", { name: "Wiki で開く" }).click();
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
    .getByRole("list", { name: "ノート" })
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
    .getByRole("navigation", { name: "スレッド一覧" })
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
    .getByRole("list", { name: "ノート" })
    .getByText("認可モデル")
    .click();
  await page.getByRole("button", { name: "ノートを削除" }).click();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await openTask(page, "用語プレビュー");
  await page
    .getByRole("navigation", { name: "スレッド一覧" })
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

test("ノートの本文の用語から、説明と同じ Wiki の別のノートを開ける（#210）", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "本文の用語");
  for (const [title, aliases, body] of [
    ["権限", "", "利用者ができる操作。"],
    ["ロール", "role", "権限 をまとめたもの。ロール自身と `権限` は対象外。"],
    [
      "認可",
      "",
      "ロール と ROLE で決める。[権限](https://example.com/) はリンクのまま。",
    ],
  ] as const) {
    await openWiki(page, "本文の用語");
    await page.getByRole("button", { name: "新しいノート" }).click();
    await page.getByRole("textbox", { name: "ノートのタイトル" }).fill(title);
    await page
      .getByRole("textbox", { name: "別名（カンマ区切り）" })
      .fill(aliases);
    await page.getByRole("textbox", { name: "本文（Markdown）" }).fill(body);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }

  // Wiki の個別画面: 別のノートのタイトル・別名に下線。リンクの中は対象外
  const body = page.locator("[data-wiki-page-body]");
  const terms = body.locator("button[data-wiki-term]");
  await expect(terms).toHaveText(["ロール", "ROLE"]);
  // （Streamdown は外部リンクを、確認してから開くボタンにする）
  await expect(
    body.getByRole("button", { name: "権限", exact: true }),
  ).toBeVisible();

  // ホバーで要約を出し、クリックでノートを開く
  await terms.first().hover();
  const card = page.getByRole("dialog", { name: "用語の説明" });
  await expect(card).toContainText("権限 をまとめたもの。");
  await terms.first().click();
  await expect(page.getByRole("heading", { name: "ロール" })).toBeVisible();
  // 閲覧中のノート自身と、コードの中は対象外
  await expect(terms).toHaveText(["権限"]);

  // キーボードでフォーカスすると要約を出し、Enter で開く
  await terms.first().focus();
  await expect(card).toContainText("利用者ができる操作。");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "権限" })).toBeVisible();
  await expect(terms).toHaveCount(0);

  // 本文の選択メニューはそのまま使える
  await page.getByRole("button", { name: "ロール" }).click();
  await expect(page.getByRole("heading", { name: "ロール" })).toBeVisible();
  await body.getByText("をまとめたもの").selectText();
  await expect(
    page
      .getByRole("toolbar", { name: "選択範囲の操作" })
      .getByRole("button", { name: "質問", exact: true }),
  ).toBeVisible();

  // 会話の右側のペイン: 本文の用語を押すと、同じペインで開く
  await openTask(page, "本文の用語");
  await newChat(page);
  await send(page, "認可 について");
  await idle(page);
  const main = page.getByRole("region", { name: "メインのチャット" });
  await main
    .locator("button[data-wiki-term]", { hasText: "認可" })
    .first()
    .click();
  const pane = page.getByRole("complementary", { name: "ノート" });
  await expect(pane.getByRole("heading", { name: "認可" })).toBeVisible();
  const paneTerms = pane.locator(
    "[data-wiki-page-body] button[data-wiki-term]",
  );
  await expect(paneTerms).toHaveText(["ロール", "ROLE"]);
  await paneTerms.first().click();
  await expect(pane.getByRole("heading", { name: "ロール" })).toBeVisible();
  await expect(paneTerms).toHaveText(["権限"]);
});

test("回答中の用語・引用をクリックすると、右側のペインで Wiki ページを開く", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "ペインの検証");
  const lastParagraph = "ノートの末尾です。";
  const longNote = [
    "主体・関係・対象の **3 つ組**。",
    ...Array.from({ length: 40 }, (_, index) => `補足 ${index + 1}`),
    lastParagraph,
  ].join("\n\n");
  for (const [title, aliases, body] of [
    ["関係タプル", "relation tuple", longNote],
    ["認可モデル", "", "権限を決める仕組み。"],
  ] as const) {
    await openWiki(page, "ペインの検証");
    await page.getByRole("button", { name: "新しいノート" }).click();
    await page.getByRole("textbox", { name: "ノートのタイトル" }).fill(title);
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
  const pane = page.getByRole("complementary", { name: "ノート" });
  const expectNoteScroll = async () => {
    const content = pane.locator(":scope > header + div");
    const close = pane.getByRole("button", { name: "ノートを閉じる" });
    const closePosition = await close.boundingBox();
    await expect(pane.getByText(lastParagraph)).not.toBeInViewport();
    await content.hover();
    await page.mouse.wheel(0, 5000);
    await expect(pane.getByText(lastParagraph)).toBeInViewport();
    expect(await close.boundingBox()).toEqual(closePosition);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(content).toHaveCSS("overscroll-behavior-y", "none");
  };
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
  await expectNoteScroll();

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
  await pane.getByRole("button", { name: "ノートを閉じる" }).click();
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
  await pane.getByRole("button", { name: "ノートを閉じる" }).click();

  // 右側のペインは 1 つだけ: サイドチャットを開いていても、用語を押すと入れ替わる
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  await selectLastAnswerParagraph(page);
  await askSelectionIn(main);
  await expect(side).toBeVisible();
  await model.click();
  await expect(pane.getByRole("heading", { name: "認可モデル" })).toBeVisible();
  await expect(side).toHaveCount(0);

  // ペインの本文を選んで質問すると、そのページについてのサイドチャットに入れ替わる
  await selectAnswerText(pane.locator("[data-wiki-page-body]"), "権限を決める");
  await page
    .getByRole("toolbar", { name: "選択範囲の操作" })
    .getByRole("button", { name: "質問", exact: true })
    .click();
  await expect(pane).toHaveCount(0);
  await expect(side).toContainText("認可モデル");
  await expect(side.locator("blockquote")).toHaveText("権限を決める");
  const sideInput = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  await expect(sideInput).toBeFocused();
  await sideInput.fill("具体例は？");
  await sideInput.press("Enter");
  await expect(side.getByText("具体例は？", { exact: true })).toBeVisible();
  await expect(mainInput).toHaveValue("書きかけの質問");
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();

  // 狭い画面ではペインが全面に出て、閉じるとメインの HEAD と下書きに戻る
  await page.setViewportSize({ width: 700, height: 740 });
  await tuple.click();
  await expect(pane.getByRole("heading", { name: "関係タプル" })).toBeVisible();
  await expect(main).toBeHidden();
  expect((await pane.boundingBox())?.width).toBe(700);
  await expectNoteScroll();
  await pane.getByRole("button", { name: "ノートを閉じる" }).click();
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

test("タスク内のスレッドでは、保存したタスクの情報が Claude に届く（#186）", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "タスク情報の検証");
  await page.getByRole("combobox", { name: "状態" }).selectOption({
    label: "進行中",
  });
  await page
    .getByRole("textbox", { name: "ゴール" })
    .fill("API 仕様をレビューする");
  await page.getByRole("button", { name: "進捗を保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  await page
    .getByRole("textbox", { name: "URL" })
    .last()
    .fill("https://example.com/design");
  await page
    .getByRole("textbox", { name: "表示名（任意）" })
    .last()
    .fill("設計資料");
  await page.getByRole("button", { name: "追加", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "関連リンク" }).getByRole("link"),
  ).toHaveCount(1);

  await newChat(page);
  await send(
    page,
    "このタスクのゴールと、関連リンクを教えて。タスクの情報を教えて",
  );
  const answer = page.locator("[data-assistant-message]").last();
  await expect(answer).toContainText("タスク名: タスク情報の検証");
  await expect(answer).toContainText("状態: 進行中");
  await expect(answer).toContainText("API 仕様をレビューする");
  await expect(answer).toContainText("設計資料: https://example.com/design");
  await idle(page);
  // 質問の吹き出しには参照情報を混ぜない
  await expect(page.getByText("<task-context>")).toHaveCount(0);

  // 未所属のスレッドには付けない
  await newUnassignedChat(page);
  await send(page, "タスクの情報を教えて");
  await expect(page.getByText("タスクの情報はありません")).toBeVisible();
  await idle(page);
});

test("チャットからタスクの進捗と関連リンクを更新し、タスク画面で確認できる（#187）", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "ツール更新の検証");
  const status = page.getByRole("combobox", { name: "状態" });
  const nextAction = page.getByRole("textbox", { name: "ゴール" });
  const links = page.getByRole("list", { name: "関連リンク" });
  await page.getByRole("textbox", { name: "進捗メモ" }).fill("設計を進めた");
  await page.getByRole("button", { name: "進捗を保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");

  await newChat(page);
  const chatUrl = page.url();
  await send(page, "タスクを更新: in_progress|API 仕様をレビューする");
  await expect(page.getByText("進捗を反映しました。")).toBeVisible();
  await idle(page);
  await send(page, "リンクを追加: https://example.com/spec|仕様書");
  await expect(page.getByText("リンクを登録しました。")).toBeVisible();
  await idle(page);
  // 不正な URL は追加しない
  await send(page, "リンクを追加: javascript:alert(1)|だめなリンク");
  await idle(page);

  // 指定した項目だけがタスク画面に反映される
  await openTask(page, "ツール更新の検証");
  await expect(status).toHaveValue("in_progress");
  await expect(nextAction).toHaveValue("API 仕様をレビューする");
  await expect(page.getByRole("textbox", { name: "進捗メモ" })).toHaveValue(
    "設計を進めた",
  );
  await expect(links.getByRole("link")).toHaveCount(1);
  await expect(links.getByRole("link", { name: /仕様書/ })).toHaveAttribute(
    "href",
    "https://example.com/spec",
  );

  // 次の回答に使うタスク情報にも反映される
  await page.goto(chatUrl);
  await send(page, "タスクの情報を教えて");
  const answer = page.locator("[data-assistant-message]").last();
  await expect(answer).toContainText("状態: 進行中");
  await expect(answer).toContainText("仕様書: https://example.com/spec");
  await idle(page);
});

test("入力欄の下に所属環境の名前を出し、押すと詳細を開く（#192）", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "環境表示の検証");
  await newChat(page);
  const main = page.getByRole("region", { name: "メインのチャット" });
  const button = main.getByRole("button", {
    name: "環境: 環境表示の検証（詳細を開く）",
  });
  await expect(button).toBeVisible();
  // 作業ディレクトリ名ではなく、環境名を出す
  await expect(button).toHaveText("環境表示の検証");

  await button.click();
  const details = main.getByRole("dialog", {
    name: "環境「環境表示の検証」の詳細",
  });
  await expect(details).toContainText("説明（なし）");
  await expect(details).toContainText("参照する Wiki環境表示の検証");
  await expect(details).toContainText("/e2e（既定の作業ディレクトリ）");
  await expect(details).not.toContainText("このスレッドの作業ディレクトリ");
  // 閉じると入力を続けられる
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(button).toBeFocused();
  const box = page.getByRole("textbox", { name: "メッセージ", exact: true });
  await box.fill("続けて入力");
  await expect(box).toHaveValue("続けて入力");
  await box.fill("");

  // 別の環境のスレッドに切り替えると、環境名も変わる
  await createTask(page, "別環境の検証");
  await newChat(page);
  await expect(
    main.getByRole("button", { name: "環境: 別環境の検証（詳細を開く）" }),
  ).toBeVisible();

  // 未所属のスレッドには環境名を出さない
  await newUnassignedChat(page);
  await expect(main.getByRole("button", { name: /^環境: / })).toHaveCount(0);
});

test("タスクの進捗を記録し、一覧で状態ごとに確認できる", async ({ page }) => {
  await open(page);
  const status = page.getByRole("combobox", { name: "状態" });
  const progress = page.getByRole("region", { name: "進捗" });

  await createTask(page, "進捗A");
  await expect(status).toHaveValue("not_started");
  await expect(progress).toContainText("最終更新: —");

  // 状態はすぐ保存、ゴール・進捗メモは「進捗を保存」で保存
  await status.selectOption({ label: "進行中" });
  await expect(progress).not.toContainText("最終更新: —");
  await page
    .getByRole("textbox", { name: "ゴール" })
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
  await expect(page.getByRole("textbox", { name: "ゴール" })).toHaveValue("");

  // スレッドで会話を続けても、状態と最終更新は変わらない
  await openTask(page, "進捗A");
  await newChat(page);
  await send(page, "進捗の続き");
  await idle(page);
  await openTask(page, "進捗A");
  await expect(status).toHaveValue("in_progress");
  await expect(progress.getByText(/最終更新:/)).toHaveText(updatedText ?? "");

  // カンバンで状態ごとの列に並び、カードにゴールを出す（#195）
  await page.getByRole("button", { name: "タスク一覧" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(card(page, "進捗A")).toContainText("検証環境で権限モデルを試す");
  await expect(column(page, "進行中")).toContainText("進捗A");
  await expect(column(page, "未着手")).toContainText("進捗B");

  // カードを別の列にドロップすると保存し、リロードしても移動先に出る
  await card(page, "進捗B").dragTo(column(page, "保留"));
  await expect(column(page, "保留")).toContainText("進捗B");
  await expect(column(page, "未着手")).not.toContainText("進捗B");
  await page.reload();
  await expect(column(page, "保留")).toContainText("進捗B");

  // 完了してもスレッド・Wiki・関連リンクを開け、進行中に戻せる
  await card(page, "進捗A").getByRole("button", { name: "進捗A" }).click();
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

test("タスクをアーカイブして通常の一覧から隠し、アーカイブ済みから閲覧・復元できる（#241）", async ({
  page,
}) => {
  await open(page);
  const status = page.getByRole("combobox", { name: "状態" });
  const notice = page.getByRole("region", { name: "アーカイブ済み" });

  await createTask(page, "整理A");
  await status.selectOption({ label: "保留" });
  await page.getByRole("textbox", { name: "ゴール" }).fill("リリースを待つ");
  await page.getByRole("button", { name: "進捗を保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  await page
    .getByRole("textbox", { name: "URL" })
    .last()
    .fill("https://example.com/a");
  await page.getByRole("button", { name: "追加", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "関連リンク" }).getByRole("link"),
  ).toHaveCount(1);
  await newChat(page);
  await send(page, "アーカイブ前の質問");
  await idle(page);
  const chatUrl = page.url();

  // 左ペインのメニューからアーカイブすると、左ペインとカンバンから消える
  await openTaskMenu(page, "整理A", "アーカイブ");
  await expect(taskRow(page, "整理A")).toHaveCount(0);
  // 開いていた会話はそのまま読める
  await expect(page.getByText("了解: アーカイブ前の質問")).toBeVisible();
  await page.getByRole("button", { name: "タスク一覧" }).click();
  await expect(card(page, "整理A")).toHaveCount(0);

  // 「アーカイブ済み」から概要と所属スレッドを見返せる。再読み込みしても残る
  await page.getByRole("button", { name: "アーカイブ済み（1）" }).click();
  await expect(page).toHaveURL(/\/tasks\/archived$/);
  await page.reload();
  const item = page.locator("[data-archived-task]");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("整理A");
  await expect(item).toContainText("保留");
  await expect(item).toContainText("スレッド 1 件");
  await expect(item).toContainText("リリースを待つ");
  await item.getByRole("button", { name: "整理A", exact: true }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);
  const taskUrl = page.url();
  await expect(notice).toBeVisible();
  await expect(status).toHaveValue("on_hold");
  await expect(
    page.getByRole("list", { name: "関連リンク" }).getByRole("link"),
  ).toHaveCount(1);
  await page
    .getByRole("main")
    .getByRole("button", { name: /アーカイブ前の質問/ })
    .click();
  await expect(page.getByText("了解: アーカイブ前の質問")).toBeVisible();

  // スレッドへの直接のリンクからも開ける
  await page.goto(chatUrl);
  await expect(page.getByText("了解: アーカイブ前の質問")).toBeVisible();
  await expect(taskRow(page, "整理A")).toHaveCount(0);

  // 復元すると、元の状態・環境で通常の一覧に戻る
  await page.goto(taskUrl);
  await notice.getByRole("button", { name: "復元" }).click();
  await expect(notice).toHaveCount(0);
  await expect(taskRow(page, "整理A")).toBeVisible();
  await expect(status).toHaveValue("on_hold");
  await expect(page.getByRole("textbox", { name: "ゴール" })).toHaveValue(
    "リリースを待つ",
  );
  await expect(taskItem(page, "整理A")).toContainText("アーカイブ前の質問");
  await page.reload();
  await expect(taskRow(page, "整理A")).toBeVisible();
  await page.getByRole("button", { name: "タスク一覧" }).click();
  await expect(column(page, "保留")).toContainText("整理A");
  await expect(
    page.getByRole("button", { name: "アーカイブ済み（0）" }),
  ).toBeVisible();

  // アーカイブ済みの一覧からも復元できる
  await openTaskMenu(page, "整理A", "アーカイブ");
  await page.getByRole("button", { name: "アーカイブ済み（1）" }).click();
  await page.getByRole("button", { name: "「整理A」を復元" }).click();
  await expect(page.locator("[data-archived-task]")).toHaveCount(0);
  await expect(taskRow(page, "整理A")).toBeVisible();
});

test("カンバンの保存に失敗したら元の列に戻し、左パネルは進捗で絞り込める（#195）", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "カンバンA");
  await page.getByRole("combobox", { name: "状態" }).selectOption({
    label: "進行中",
  });
  await expect(page.getByRole("region", { name: "進捗" })).not.toContainText(
    "最終更新: —",
  );
  await createTask(page, "カンバンB");
  await page.getByRole("combobox", { name: "状態" }).selectOption({
    label: "保留",
  });
  await expect(page.getByRole("region", { name: "進捗" })).not.toContainText(
    "最終更新: —",
  );
  await createTask(page, "カンバンC");

  // 保存に失敗すると元の列に戻り、失敗が分かる
  await page.getByRole("button", { name: "タスク一覧" }).click();
  await page.route("**/tasks/updateProgress**", (route) =>
    route.fulfill({ status: 500, body: "{}" }),
  );
  await card(page, "カンバンC").dragTo(column(page, "完了"));
  await expect(page.getByRole("alert")).toContainText(
    "「カンバンC」を「完了」にできませんでした",
  );
  await expect(column(page, "未着手")).toContainText("カンバンC");
  await expect(column(page, "完了")).not.toContainText("カンバンC");
  await page.unroute("**/tasks/updateProgress**");

  // キーボードでもカードの「状態」から移せる。左パネルにも反映する
  await page
    .getByRole("combobox", { name: "「カンバンC」の状態" })
    .selectOption({ label: "進行中" });
  await expect(column(page, "進行中")).toContainText("カンバンC");

  // 左パネルの「フィルタ」ボタンからメニューを開き、「進行中」と「保留」を
  // 続けて選ぶと、そのどちらかのタスクだけを出す（#208）
  const filterButton = page.getByRole("button", { name: /^フィルタ/ });
  const filter = page.getByRole("menu", { name: "進捗で絞り込む" });
  await expect(filter).toHaveCount(0);
  await filterButton.click();
  await filter.getByRole("menuitemcheckbox", { name: "進行中" }).click();
  // 選んでもメニューは閉じない
  await filter.getByRole("menuitemcheckbox", { name: "保留" }).click();
  await expect(
    filter.getByRole("menuitemcheckbox", { name: "進行中" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    filter.getByRole("menuitemcheckbox", { name: "未着手" }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(filterButton).toHaveAccessibleName("フィルタ（進行中・保留）");
  // Escape で閉じる
  await page.keyboard.press("Escape");
  await expect(filter).toHaveCount(0);
  await expect(filterButton).toBeFocused();
  await expect(taskRow(page, "カンバンA")).toBeVisible();
  await expect(taskRow(page, "カンバンB")).toBeVisible();
  await expect(taskRow(page, "カンバンC")).toBeVisible();
  // 状態を変えると、表示対象も変わる
  await page
    .getByRole("combobox", { name: "「カンバンC」の状態" })
    .selectOption({ label: "完了" });
  await expect(taskRow(page, "カンバンC")).toHaveCount(0);
  // カンバンは全状態の列を出す
  await expect(column(page, "完了")).toContainText("カンバンC");
  // フラット表示でも効く。リロードしても保つ
  await page.getByRole("button", { name: "環境ごとにまとめる" }).click();
  await page.reload();
  await expect(taskRow(page, "カンバンA")).toBeVisible();
  await expect(taskRow(page, "カンバンC")).toHaveCount(0);
  // 選択をすべて外すと全件に戻る。キーボードでも選べる
  await filterButton.focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    filter.getByRole("menuitemcheckbox", { name: "未着手" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(
    filter.getByRole("menuitemcheckbox", { name: "進行中" }),
  ).toHaveAttribute("aria-checked", "false");
  await filter.getByRole("menuitemcheckbox", { name: "保留" }).click();
  await expect(filterButton).toHaveAccessibleName("フィルタ");
  await expect(taskRow(page, "カンバンC")).toBeVisible();
  // メニューの外を押すと閉じる
  await expect(filter).toBeVisible();
  await column(page, "未着手").click({ position: { x: 4, y: 4 } });
  await expect(filter).toHaveCount(0);
  await page.getByRole("button", { name: "環境ごとにまとめる" }).click();
});

test("ゴールを実行すると /goal のスレッドを作って開き、実行状況でタスクの進捗を自動で更新する（#198）", async ({
  page,
}) => {
  const status = page.getByRole("combobox", { name: "状態" });
  const panel = page.getByRole("region", { name: "ゴールの実行" });
  const runState = panel.getByTestId("goal-run-state");
  /** ゴールを保存して実行し、作られたスレッドに移る。 */
  const runGoal = async (task: string, goal: string) => {
    await createTask(page, task);
    await expect(panel.getByRole("button", { name: "実行" })).toBeDisabled();
    await page.getByRole("textbox", { name: "ゴール" }).fill(goal);
    // 保存するまでは実行できない
    await expect(panel.getByRole("button", { name: "実行" })).toBeDisabled();
    await page.getByRole("button", { name: "進捗を保存" }).click();
    await expect(page.getByRole("status")).toHaveText("保存しました");
    await panel.getByRole("button", { name: "実行" }).click();
    await expect(page).toHaveURL(/\/c\/.+/);
    await expect(page.getByText(`Goal set: ${goal}`)).toBeVisible();
  };

  await open(page);
  // 達成を確認すると完了
  await runGoal("ゴール達成の検証", "テストがすべて通る");
  await expect(
    page.getByText("ゴールに向けた作業が終わりました。"),
  ).toBeVisible();
  await idle(page);
  await openTask(page, "ゴール達成の検証");
  await expect(runState).toHaveText("達成");
  await expect(status).toHaveValue("done");
  await expect(panel.getByTestId("goal-run-reason")).toHaveText(
    "条件を満たしました",
  );
  // 実行のスレッドはタスクに属し、タスクから開ける
  await panel
    .getByRole("button", { name: "直近の実行のスレッドを開く" })
    .click();
  await expect(page.getByText("Goal set: テストがすべて通る")).toBeVisible();

  // 判定できないまま止まると要確認。スレッドで答えて再開すると進行中に戻り、達成で完了
  await runGoal("ゴール要確認の検証", "要確認が必要な作業を終える");
  await expect(page.getByText("どちらの方針で進めますか？")).toBeVisible();
  await idle(page);
  await openTask(page, "ゴール要確認の検証");
  await expect(runState).toHaveText("要確認");
  await expect(status).toHaveValue("needs_review");
  await expect(panel.getByTestId("goal-run-reason")).toContainText(
    "判定できないまま止まりました",
  );
  // 要確認の間も多重に起動しない
  await expect(panel.getByRole("button", { name: "停止" })).toBeVisible();
  await expect(panel.getByRole("button", { name: /実行$/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "実行中のスレッドを開く" }).click();
  await send(page, "方針A で進めて");
  await expect(
    page.getByText("方針A で進めて、ゴールを達成しました。"),
  ).toBeVisible();
  await idle(page);
  await openTask(page, "ゴール要確認の検証");
  await expect(runState).toHaveText("達成");
  await expect(status).toHaveValue("done");

  // 達成不能なら保留にして理由を出し、再実行できる
  await runGoal("ゴール不能の検証", "不可能な条件を満たす");
  await idle(page);
  await openTask(page, "ゴール不能の検証");
  await expect(runState).toHaveText("達成できず");
  await expect(status).toHaveValue("on_hold");
  await expect(panel.getByTestId("goal-run-reason")).toHaveText(
    "条件が矛盾しているため達成できません",
  );
  await expect(panel.getByRole("button", { name: "再実行" })).toBeEnabled();

  // ツールの承認待ちは要確認。カンバンの要確認の列にも出る。承認すると進み、達成で完了
  await runGoal("ゴール承認の検証", "承認が必要な作業を終える");
  const approval = page.getByRole("region", { name: "ツール実行の承認" });
  await expect(approval).toBeVisible();
  await page.getByRole("button", { name: "タスク一覧" }).click();
  await expect(column(page, "要確認")).toContainText("ゴール承認の検証");
  await page.goBack();
  await approval.getByRole("button", { name: "許可" }).click();
  await expect(
    page.getByText("ゴールに向けた作業が終わりました。"),
  ).toBeVisible();
  await idle(page);
  await openTask(page, "ゴール承認の検証");
  await expect(runState).toHaveText("達成");
  await expect(status).toHaveValue("done");
});

test("回答から分岐し、同じスレッドの中で会話を切り替えて続けられる", async ({
  page,
}) => {
  await open(page);
  const list = page.getByRole("navigation", { name: "スレッド一覧" });
  const main = page.getByRole("main");
  const branchSelect = branchMenu(page);
  const branchButtons = main.getByRole("button", { name: "ここから分岐" });

  await newChat(page);
  await send(page, "分岐の設計案は？");
  await idle(page);
  await send(page, "同期で進めて");
  await idle(page);

  // 取り消すと元の表示に戻り、新しい会話は作られない
  await main.getByRole("button", { name: "回答を開く" }).click();
  await branchButtons.first().click();
  await expect(main.getByText("この回答の続きとして分岐します")).toBeVisible();
  await expect(main.getByText("了解: 同期で進めて")).toHaveCount(0);
  await main.getByRole("button", { name: "取り消す" }).click();
  await expect(main.getByText("了解: 同期で進めて")).toBeVisible();
  await expect(branchSelect.trigger).toHaveCount(0);

  // 最初の回答から分岐する
  const rootUrl = page.url();
  await branchButtons.first().click();
  await send(page, "非同期だと？");
  await expect(main.getByText("了解: 非同期だと？")).toBeVisible();
  await idle(page);
  expect(page.url()).not.toBe(rootUrl);
  await expect(main.getByText("了解: 分岐の設計案は？")).toBeHidden();
  await expect(main.getByText("了解: 同期で進めて")).toHaveCount(0);
  await expect(main.getByText(/から引き継いだ履歴/)).toBeVisible();
  await branchSelect.expectLabels([
    "元の会話",
    "非同期だと？（元の会話 から分岐）",
  ]);
  await branchSelect.open();
  await expect(
    branchSelect.popup.getByText(
      "ファイルへの変更はスレッド内のすべての会話で共有",
    ),
  ).toBeVisible();
  await branchSelect.close();
  // サイドバーの会話は 1 つのまま
  await expect(
    list.locator("li:not(:has(li))").filter({ hasText: "分岐の設計案は？" }),
  ).toHaveCount(1);

  // 元の会話に切り替えて続ける
  await branchSelect.select("元の会話");
  await expect(main.getByText("了解: 同期で進めて")).toBeVisible();
  await send(page, "元の続き");
  await expect(main.getByText("了解: 元の続き")).toBeVisible();
  await idle(page);

  // 分岐した会話に戻って続ける
  await branchSelect.select("非同期だと？（元の会話 から分岐）");
  await expect(main.getByText("了解: 非同期だと？")).toBeVisible();
  await send(page, "分岐の続き");
  await expect(main.getByText("了解: 分岐の続き")).toBeVisible();
  await idle(page);
  await expect(main.getByText("了解: 元の続き")).toHaveCount(0);

  // 分岐した会話からさらに分岐する
  await main.getByRole("button", { name: "回答を開く" }).nth(1).click();
  await branchButtons.first().click();
  await send(page, "さらに分岐");
  await expect(main.getByText("了解: さらに分岐")).toBeVisible();
  await idle(page);
  await branchSelect.expectCount(3);
  await expect(
    list.locator("li:not(:has(li))").filter({ hasText: "分岐の設計案は？" }),
  ).toHaveCount(1);

  // 元の会話を編集しても、分岐した会話の履歴は残る
  await branchSelect.select("元の会話");
  await main.getByText("分岐の設計案は？").first().hover();
  await main.getByRole("button", { name: "この発話を編集" }).first().click();
  await page
    .getByRole("textbox", { name: "発話を編集" })
    .fill("書き直した質問");
  await page.getByRole("button", { name: "送信", exact: true }).first().click();
  await expect(main.getByText("了解: 書き直した質問")).toBeVisible();
  await idle(page);
  await branchSelect.select("非同期だと？（元の会話 から分岐）");
  await expect(main.getByText("了解: 分岐の設計案は？")).toBeHidden();
  await main.getByRole("button", { name: "回答を開く" }).first().click();
  await expect(main.getByText("了解: 分岐の設計案は？")).toBeVisible();
  await expect(main.getByText("了解: 分岐の続き")).toBeVisible();

  // リロードしても、最後に選んだ会話が開く。サイドバーから開いても同じ
  await page.reload();
  await expect(branchSelect.trigger).toBeVisible();
  await branchSelect.expectCurrent("非同期だと？（元の会話 から分岐）");
  await newChat(page);
  await list
    .locator("li:not(:has(li))")
    .filter({ hasText: "分岐の設計案は？" })
    .click();
  await branchSelect.expectCurrent("非同期だと？（元の会話 から分岐）");
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

/**
 * 「ここから分岐」で新しい分岐を作り始める（#242）。その回答から分岐した会話があれば
 * メニューが開くので、「新しい分岐を作成」を選ぶ。
 */
const startBranch = async (page: Page, button: Locator) => {
  const hasMenu = (await button.getAttribute("aria-haspopup")) === "dialog";
  await button.click();
  if (hasMenu) {
    await page
      .getByRole("dialog", { name: "この回答から分岐した会話" })
      .getByRole("button", { name: /新しい分岐を作成$/ })
      .first()
      .click();
  }
};

test("分岐点の回答から、そこで分岐した会話を開け、引き継いだ履歴の区切りから分岐元に戻れる（#235）", async ({
  page,
}) => {
  await open(page);
  const main = page.getByRole("main");
  const branches = branchMenu(page);
  // 分岐した会話のある回答の「ここから分岐」には、その数を出す（#242）
  const forkButton = main.getByRole("button", { name: /^ここから分岐\s*\d+/ });
  const forkPopup = page.getByRole("dialog", {
    name: "この回答から分岐した会話",
  });
  const side = page.getByRole("complementary", { name: "サイドチャット" });

  await newChat(page);
  await send(page, "分岐点の設計案は？");
  await idle(page);
  await send(page, "そのまま進めて");
  await idle(page);
  // 分岐が無いうちは出さない
  await expect(forkButton).toHaveCount(0);

  // 最初の回答から分岐する
  await main.getByRole("button", { name: "回答を開く" }).click();
  await main.getByRole("button", { name: "ここから分岐" }).first().click();
  await send(page, "別案だと？");
  await idle(page);
  await expect(branches.trigger).toContainText("別案だと？");

  // 引き継いだ履歴の区切りから、分岐元に戻れる
  await main.getByRole("button", { name: "元の会話", exact: true }).click();
  await expect(branches.trigger).toContainText("元の会話");
  await expect(main.getByText("了解: そのまま進めて")).toBeVisible();

  // 分岐点の回答（閉じていても）から、そこで分岐した会話が分かり、開ける
  await expect(forkButton).toHaveCount(1);
  await expect(forkButton).toHaveText(/ここから分岐\s*1/);
  await forkButton.click();
  await expect(
    forkPopup.getByRole("button", { name: "別案だと？（元の会話 から分岐）" }),
  ).toBeVisible();
  // サイドで開く
  await forkPopup
    .getByRole("button", { name: "「別案だと？」をサイドで開く" })
    .click();
  await expect(side.getByText("了解: 別案だと？")).toBeVisible();
  await expect(branches.trigger).toContainText("元の会話");
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();

  // メインで開く
  await forkButton.click();
  await forkPopup
    .getByRole("button", { name: "別案だと？（元の会話 から分岐）" })
    .click();
  await expect(branches.trigger).toContainText("別案だと？");
  await expect(forkPopup).toHaveCount(0);
});

test("「ここから分岐」で新しい分岐を作り、分岐があればメニューから既存の分岐を開くか新しく作れる（#242）", async ({
  page,
}) => {
  await open(page);
  const main = page.getByRole("main");
  const branches = branchMenu(page);
  const mainInput = main.getByRole("textbox", {
    name: "メッセージ",
    exact: true,
  });
  const notice = main.getByText("この回答の続きとして分岐します。");
  const origin = main.getByTestId("branch-origin");
  const lastAnswer = main.locator("[data-assistant-message]").last();
  const forkPopup = page.getByRole("dialog", {
    name: "この回答から分岐した会話",
  });

  await newChat(page);
  await send(page, "起点の質問");
  await idle(page);
  await send(page, "末尾の質問");
  await idle(page);

  // 閉じた回答からも、分岐が無ければすぐに新しい分岐を作り始め、入力欄に移る。起点が分かる
  await main
    .getByRole("button", { name: "ここから分岐", exact: true })
    .first()
    .click();
  await expect(notice).toBeVisible();
  await expect(origin).toContainText("了解: 起点の質問");
  await expect(mainInput).toBeFocused();
  await expect(main.getByText("了解: 末尾の質問")).toHaveCount(0);
  // 送信前に取り消すと、元の会話に戻る
  await main.getByRole("button", { name: "取り消す" }).click();
  await expect(notice).toHaveCount(0);
  await expect(main.getByText("了解: 末尾の質問")).toBeVisible();
  await expect(branches.trigger).toHaveCount(0);

  // 会話の末尾の回答からも新しい分岐を作れる
  await lastAnswer.getByRole("button", { name: "ここから分岐" }).click();
  await expect(notice).toBeVisible();
  await expect(origin).toContainText("了解: 末尾の質問");
  await expect(main.locator("[data-branch-origin]")).toHaveCount(1);
  await expect(mainInput).toBeFocused();
  await send(page, "末尾から分岐");
  await expect(main.getByText("了解: 末尾から分岐")).toBeVisible();
  await idle(page);
  await branches.expectLabels([
    "元の会話",
    "末尾から分岐（元の会話 から分岐）",
  ]);

  // 分岐があれば、メニューから既存の分岐を開くか、新しい分岐を作るかを選べる
  await branches.select("元の会話");
  const forkButton = lastAnswer.getByRole("button", { name: /^ここから分岐/ });
  await expect(forkButton).toHaveText(/ここから分岐\s*1/);
  await forkButton.click();
  await expect(
    forkPopup.getByRole("button", {
      name: "末尾から分岐（元の会話 から分岐）",
    }),
  ).toBeVisible();
  await forkPopup.getByRole("button", { name: "新しい分岐を作成" }).click();
  await expect(forkPopup).toHaveCount(0);
  await expect(notice).toBeVisible();
  await expect(origin).toContainText("了解: 末尾の質問");
  await expect(mainInput).toBeFocused();
  await send(page, "末尾から二つ目");
  await expect(main.getByText("了解: 末尾から二つ目")).toBeVisible();
  await idle(page);
  await branches.expectCount(3);

  // 同じメニューから既存の分岐をメインで開ける
  await branches.select("元の会話");
  await expect(forkButton).toHaveText(/ここから分岐\s*2/);
  await forkButton.click();
  await forkPopup
    .getByRole("button", { name: "末尾から分岐（元の会話 から分岐）" })
    .click();
  await expect(branches.trigger).toContainText("末尾から分岐");
  await expect(main.getByText("了解: 末尾から分岐")).toBeVisible();
});

test("回答の選択範囲を引用して質問すると、引用付きの会話ができる", async ({
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
  await page.getByRole("button", { name: "新しいノート" }).click();
  await page.getByRole("textbox", { name: "ノートのタイトル" }).fill("方式B");
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
  // 末尾の回答からも新しい分岐を作り始められる（#242）。取り消すとこの会話に戻り、入力は残る
  await main.getByRole("button", { name: "ここから分岐" }).click();
  await expect(
    main.getByText("この回答の続きとして分岐します。"),
  ).toBeVisible();
  await expect(mainInput).toBeFocused();
  await main.getByRole("button", { name: "取り消す" }).click();
  await expect(main.getByText("この回答の続きとして分岐します。")).toHaveCount(
    0,
  );
  await expect(mainInput).toHaveValue("メインの続き");
  await expect(ask).toHaveCount(0);

  // 用語はクリックで右側のペインに開く（選択してもペインは開かない）
  const term = main.locator("button[data-wiki-term]").last();
  const wikiPane = page.getByRole("complementary", { name: "ノート" });
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

  // 開くと、そのまま質問を書けるよう入力欄にフォーカスが移る（#220）。
  // 初回送信前に閉じると新しい会話はできない。メインの入力も残る。
  await askSelectionIn(main);
  await expect(popup).toHaveCount(0);
  await expect(side.locator("blockquote")).toContainText(
    "方式A と 方式B の比較",
  );
  await expect(sideInput).toBeFocused();
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();
  await expect(mainInput).toBeFocused();
  await expect(mainInput).toHaveValue("メインの続き");
  await expect(branchMenu(page).trigger).toHaveCount(0);

  // 閉じて開き直しても入力欄にフォーカスが移り、クリックせずに書き始められる。
  // 送ると、引用付きの会話ができ、モデルには引用と質問が区別して届く
  await selectLastAnswerParagraph(page);
  await askSelectionIn(main);
  await expect(sideInput).toBeFocused();
  await page.keyboard.type("失敗時はどう復旧する？");
  await expect(sideInput).toHaveValue("失敗時はどう復旧する？");
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

  // 2 ターン目と承認操作もサイドの会話へ届く。
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
  await expect(branchMenu(page).trigger).toBeVisible();
  await branchMenu(page).expectCount(2);
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();
  await expect(side).toHaveCount(0);

  // リロードしても引用と質問が残り、元の会話もそのまま
  await page.reload();
  const branches = branchMenu(page);
  await branches.expectCurrent("元の会話");
  await branches.select("失敗時はどう復旧する？（元の会話 から分岐）");
  await expect(main.locator("blockquote").first()).toContainText(
    "方式A と 方式B の比較",
  );
  await expect(
    main.getByText("失敗時はどう復旧する？", { exact: true }).first(),
  ).toBeVisible();
  await branches.select("元の会話");
  await expect(main.locator("blockquote")).toHaveCount(0);
});

test("回答を引用して質問するとき、メイン・サイドチャットのどちらでも続ける会話を選べる（#222）", async ({
  page,
}) => {
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
  const branches = branchMenu(page);
  const sideIdle = () =>
    expect(side.getByRole("button", { name: "送信", exact: true })).toBeVisible(
      { timeout: 15_000 },
    );
  const menuOf = (scope: Locator) =>
    scope
      .getByRole("toolbar", { name: "選択範囲の操作" })
      .getByRole("menu", { name: "引用して続ける先" });

  await send(page, "最初の質問");
  await idle(page);

  // メイン: 「質問」から、表示中の会話で続けるか、新しいサイドチャットかを選べる
  await selectLastAnswerParagraph(page);
  await main
    .getByRole("toolbar", { name: "選択範囲の操作" })
    .getByRole("button", { name: "質問", exact: true })
    .click();
  await expect(menuOf(main).getByRole("menuitem")).toHaveText([
    "この会話で続ける",
    "サイドチャットで質問",
  ]);
  await expect(menuOf(main).getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menuOf(main)).toHaveCount(0);

  // 表示中の会話で続ける: 入力欄に引用が付き、送信前に外せる
  await selectLastAnswerParagraph(page);
  await askSelectionIn(main, "この会話で続ける");
  await expect(side).toHaveCount(0);
  const mainQuote = main.locator("blockquote");
  await expect(mainQuote).toHaveText("了解: 最初の質問");
  await expect(mainInput).toBeFocused();
  await main.getByRole("button", { name: "引用を外す" }).click();
  await expect(mainQuote).toHaveCount(0);
  await selectLastAnswerParagraph(page);
  await askSelectionIn(main, "この会話で続ける");
  await page.keyboard.type("引用の続き");
  await mainInput.press("Enter");
  await expect(
    main.getByText(/了解: 以下は、直前までの回答から利用者が選んだ引用です/),
  ).toBeVisible();
  await idle(page);
  // 新しい会話はできず、引用は送ったメッセージに残る
  await expect(branches.trigger).toHaveCount(0);
  await expect(mainQuote).toHaveText("了解: 最初の質問");

  // 新しいサイドチャットで質問する
  await selectLastAnswerParagraph(page);
  await askSelectionIn(main);
  await expect(sideInput).toBeFocused();
  await page.keyboard.type("サイドの質問");
  await sideInput.press("Enter");
  await expect(
    side.getByText("サイドの質問", { exact: true }).first(),
  ).toBeVisible();
  await sideIdle();
  await branches.expectCount(2);

  // サイドチャット: 表示中のサイドチャットで続けるか、別の会話に分岐するかを選べる
  const sideAnswer = () =>
    selectAnswerParagraph(side.locator("[data-assistant-message]").last());
  await sideAnswer();
  await side
    .getByRole("toolbar", { name: "選択範囲の操作" })
    .getByRole("button", { name: "質問", exact: true })
    .click();
  await expect(menuOf(side).getByRole("menuitem")).toHaveText([
    "このサイドチャットで続ける",
    "別の会話に分岐して質問",
  ]);
  await page.keyboard.press("Escape");

  // 表示中のサイドチャットで続ける
  await sideAnswer();
  await askSelectionIn(side, "このサイドチャットで続ける");
  await expect(side.getByRole("button", { name: "引用を外す" })).toBeVisible();
  await expect(sideInput).toBeFocused();
  await page.keyboard.type("サイドの続き");
  await sideInput.press("Enter");
  await expect(
    side.getByText("サイドの続き", { exact: true }).first(),
  ).toBeVisible();
  await sideIdle();
  await branches.expectCount(2);

  // 別の会話に分岐して質問する: 送信前なら取り消せて、会話は増えない
  const branchNotice = side.getByText(
    "この回答の続きとして分岐します。入力欄から送信すると、同じスレッドに新しい会話ができます。",
  );
  await sideAnswer();
  await askSelectionIn(side, "別の会話に分岐して質問");
  await expect(branchNotice).toBeVisible();
  await expect(sideInput).toBeFocused();
  await side.getByRole("button", { name: "引用を外す" }).click();
  await expect(branchNotice).toHaveCount(0);
  await expect(
    side.getByText("サイドの続き", { exact: true }).first(),
  ).toBeVisible();

  // 送ると、初めて新しい会話ができ、サイドチャットはその会話を開く
  await sideAnswer();
  await askSelectionIn(side, "別の会話に分岐して質問");
  await expect(branchNotice).toBeVisible();
  await page.keyboard.type("分岐した質問");
  await sideInput.press("Enter");
  await expect(
    side.getByText("分岐した質問", { exact: true }).first(),
  ).toBeVisible();
  await sideIdle();
  await expect(side.getByText("サイドの続き", { exact: true })).toHaveCount(0);
  await branches.expectCount(3);

  // 分岐元の会話は、会話の切り替えから再び開ける
  await branches.select("サイドの質問（元の会話 から分岐）");
  await expect(
    main.getByText("サイドの続き", { exact: true }).first(),
  ).toBeVisible();
});

test("メインの現在地を維持したまま、入力欄から分岐に送信できる（#225）", async ({
  page,
}) => {
  await open(page);
  await newChat(page);
  const main = page.getByRole("region", { name: "メインのチャット" });
  const mainInput = main.getByRole("textbox", {
    name: "メッセージ",
    exact: true,
  });
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const branches = branchMenu(page);
  const notice = main.getByRole("status").filter({
    hasText: "現在地を維持して送信できません",
  });
  const sideIdle = () =>
    expect(side.getByRole("button", { name: "送信", exact: true })).toBeVisible(
      { timeout: 15_000 },
    );

  // 分岐元の回答がまだ無いと送らず、理由を出す（通常の送信にもならない）
  await mainInput.fill("まだ送れない");
  await mainInput.press("ControlOrMeta+Enter");
  await expect(notice).toContainText("分岐元の回答がまだありません");
  await expect(mainInput).toHaveValue("まだ送れない");
  await expect(main.locator("[data-assistant-message]")).toHaveCount(0);

  // 日本語 IME の変換確定（変換中の Enter）では、通常の送信も分岐への送信もしない
  await mainInput.fill("変換中");
  await expect(notice).toHaveCount(0);
  for (const modifier of [{}, { ctrlKey: true }, { metaKey: true }]) {
    await mainInput.evaluate((input, init) => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    }, modifier);
  }
  await expect(mainInput).toHaveValue("変換中");
  await expect(notice).toHaveCount(0);
  await expect(main.locator("[data-assistant-message]")).toHaveCount(0);

  // Shift+Enter は改行、Enter は通常の送信のまま
  await mainInput.fill("最初の質問");
  await mainInput.press("Shift+Enter");
  await expect(mainInput).toHaveValue("最初の質問\n");
  await mainInput.press("Enter");
  await expect(main.getByText("了解: 最初の質問")).toBeVisible();
  await idle(page);
  const chatUrl = page.url();

  // 現在地（会話の末尾）から分岐して送り、回答はサイドチャットに出る
  await mainInput.fill("分岐の質問");
  await mainInput.press("ControlOrMeta+Enter");
  await expect(side.getByText("了解: 分岐の質問")).toBeVisible();
  await sideIdle();
  await expect(mainInput).toHaveValue("");
  await expect(main.getByText("了解: 分岐の質問")).toHaveCount(0);
  await expect(page).toHaveURL(chatUrl);
  await branches.expectCount(2);
  await branches.expectCurrent("元の会話");

  // サイドチャットを閉じて通常送信すると、元の現在地から続く
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();
  await mainInput.fill("メインの続き");
  await mainInput.press("Enter");
  await expect(main.getByText("了解: メインの続き")).toBeVisible();
  await idle(page);
  await expect(page).toHaveURL(chatUrl);
  await branches.expectCount(2);

  // 送信ボタン横のメニューにも置き、ショートカットを確かめられる
  const menuButton = main.getByRole("button", { name: "送信のメニュー" });
  const item = main.getByRole("menuitem", { name: /現在地を維持して送信/ });
  await menuButton.click();
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(item).toContainText(/(⌘|Ctrl\+)Enter/);
  await page.keyboard.press("Escape");
  await mainInput.fill("メニューから分岐");
  await menuButton.click();
  await expect(item).not.toHaveAttribute("aria-disabled", "true");
  await item.click();
  await expect(side.getByText("了解: メニューから分岐")).toBeVisible();
  await sideIdle();
  await branches.expectCount(3);
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();

  // 「ここから分岐」で選んだ現在地も維持する
  await main.getByRole("button", { name: "回答を開く" }).first().click();
  await startBranch(
    page,
    main.getByRole("button", { name: "ここから分岐" }).first(),
  );
  const headNotice = main.getByText("この回答の続きとして分岐します。");
  await expect(headNotice).toBeVisible();
  await mainInput.fill("前の回答から");
  await mainInput.press("ControlOrMeta+Enter");
  await expect(side.getByText("了解: 前の回答から")).toBeVisible();
  await sideIdle();
  await expect(headNotice).toBeVisible();
  await branches.expectCount(4);
  // 作った分岐は、会話の切り替えから開き直せる（現在地を末尾に戻してから）
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();
  await main.getByRole("button", { name: "取り消す" }).click();
  await expect(headNotice).toHaveCount(0);
  await branches.select("分岐の質問（元の会話 から分岐）");
  await expect(
    main.getByText("了解: 分岐の質問", { exact: true }),
  ).toBeVisible();
  await branches.select("元の会話");

  // 生成中は、生成が終わった最後の回答から分岐して、回答を待たずに次々と送れる。
  // HEAD（生成中のターン）は動かさず、予約にもしない
  await mainInput.fill("ゆっくり数えて");
  await mainInput.press("Enter");
  const stopMain = main.getByRole("button", { name: "停止" });
  await expect(stopMain).toBeVisible();
  for (const [index, question] of [
    "生成中の分岐1",
    "生成中の分岐2",
  ].entries()) {
    await mainInput.fill(question);
    await mainInput.press("ControlOrMeta+Enter");
    await expect(side.getByText(`了解: ${question}`)).toBeVisible();
    await expect(mainInput).toHaveValue("");
    await expect(stopMain).toBeVisible();
    await branches.expectCount(5 + index);
  }
  // HEAD は動かない（メインは同じ会話の末尾のまま）。予約にもしない
  await branches.expectCurrent("元の会話");
  await expect(main.getByText("この回答の続きとして分岐します。")).toHaveCount(
    0,
  );
  await expect(main.getByText("了解: 生成中の分岐1")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "予約したメッセージ" }),
  ).toHaveCount(0);
  await stopMain.click();
  await idle(page);
  // 分岐は生成が終わった最後の回答の続きで、生成中だったターンを含まない
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();
  await branches.select("生成中の分岐1（元の会話 から分岐）");
  await expect(main.getByText("了解: 生成中の分岐1")).toBeVisible();
  await expect(
    main.getByText("メインの続き", { exact: true }).first(),
  ).toBeVisible();
  await expect(main.getByText("ゆっくり数えて")).toHaveCount(0);

  // 最初の回答の生成中は、生成が終わった回答が無いので送らずに理由を出す
  await newChat(page);
  await mainInput.fill("ゆっくり数えて");
  await mainInput.press("Enter");
  await expect(stopMain).toBeVisible();
  await mainInput.fill("最初の生成中の分岐");
  await mainInput.press("ControlOrMeta+Enter");
  await expect(notice).toContainText("生成が終わった回答がまだありません");
  await expect(mainInput).toHaveValue("最初の生成中の分岐");
  await expect(side).toHaveCount(0);
  await stopMain.click();
  await idle(page);
});

test("現在地を維持した送信が同時に生成できる数の上限を超えたら、理由を出して入力を残す（#225）", async ({
  page,
}) => {
  await open(page);
  await newChat(page);
  const main = page.getByRole("region", { name: "メインのチャット" });
  const mainInput = main.getByRole("textbox", {
    name: "メッセージ",
    exact: true,
  });
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const branches = branchMenu(page);
  await send(page, "最初の質問");
  await idle(page);

  // メインと 2 つの分岐で、同時に生成できる 3 件（E2E のサーバの上限）を使い切る
  await mainInput.fill("ゆっくり数えて");
  await mainInput.press("Enter");
  for (const question of ["ゆっくり A", "ゆっくり B"]) {
    await mainInput.fill(question);
    await mainInput.press("ControlOrMeta+Enter");
    await expect(
      side.getByText(question, { exact: true }).first(),
    ).toBeVisible();
  }
  await mainInput.fill("上限を超える質問");
  await mainInput.press("ControlOrMeta+Enter");
  await expect(main.getByRole("alert")).toContainText(
    "同時に生成できる会話の数の上限に達しています",
  );
  await expect(mainInput).toHaveValue("上限を超える質問");

  // 後片付け: 生成中の 3 件を止める
  await side.getByRole("button", { name: "停止" }).click();
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();
  await main.getByRole("button", { name: "停止" }).click();
  await idle(page);
  await branches.select("ゆっくり A（元の会話 から分岐）");
  const stopA = main.getByRole("button", { name: "停止" });
  if (await stopA.isVisible()) await stopA.click();
  await idle(page);
});

test("ヘッダーで会話を切り替え、ほかの会話の回答中・新しい回答が分かる（#234）", async ({
  page,
}) => {
  await open(page);
  await newChat(page);
  const main = page.getByRole("region", { name: "メインのチャット" });
  const mainInput = main.getByRole("textbox", {
    name: "メッセージ",
    exact: true,
  });
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const branches = branchMenu(page);
  await send(page, "最初の質問");
  await idle(page);
  await expect(branches.trigger).toHaveCount(0);

  // 現在地を保ったまま分岐に送り、サイドチャットを閉じて裏で回答させる
  await mainInput.fill("ゆっくり分岐");
  await mainInput.press("ControlOrMeta+Enter");
  await expect(
    side.getByText("ゆっくり分岐", { exact: true }).first(),
  ).toBeVisible();
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();

  // 切り替えはヘッダーにあり、ほかの会話が回答中だと分かる
  await expect(
    page.locator("header").getByRole("button", { name: "会話を切り替える" }),
  ).toBeVisible();
  await expect(branches.trigger).toContainText("元の会話");
  await expect(branches.trigger).toContainText("回答中 1");
  await branches.open();
  await expect(
    branches.popup
      .getByRole("listitem")
      .filter({ hasText: "ゆっくり分岐" })
      .getByLabel("生成中"),
  ).toBeVisible();
  await branches.close();

  // 回答し終えると「新しい回答」の印が付き、再読み込みしても残る
  await expect(branches.trigger).toContainText("新しい回答 1", {
    timeout: 15_000,
  });
  await expect(branches.trigger).not.toContainText("回答中");
  await page.reload();
  await expect(branches.trigger).toContainText("新しい回答 1");
  await branches.open();
  await expect(
    branches.popup.getByRole("listitem").filter({ hasText: "ゆっくり分岐" }),
  ).toContainText("新しい回答");
  await branches.close();

  // 開くと印が外れる
  await branches.select("ゆっくり分岐（元の会話 から分岐）");
  await expect(
    main.getByText("ゆっくり分岐", { exact: true }).first(),
  ).toBeVisible();
  await expect(branches.trigger).toContainText("ゆっくり分岐");
  await branches.select("元の会話");
  await expect(branches.trigger).toContainText("元の会話");
  await expect(branches.trigger).not.toContainText("新しい回答");
});

test("保存済みの会話をサイドで開き直し、メインの HEAD を保って続けられる", async ({
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
  const branchSelect = branchMenu(page);
  const openSavedBranch = async () => {
    await branchSelect.openSide("あとで再開する質問");
  };

  const firstQuestion = `保存分岐の起点 ${testInfo.repeatEachIndex}`;
  await send(page, firstQuestion);
  await expect(main.getByText(`了解: ${firstQuestion}`)).toBeVisible();
  await idle(page);
  const rootUrl = page.url();
  await selectLastAnswerParagraph(page);
  await askSelectionIn(main);
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
  await branchSelect.expectCurrent("元の会話");
  await main.getByRole("button", { name: "回答を開く" }).click();
  await startBranch(
    page,
    main.getByRole("button", { name: "ここから分岐" }).first(),
  );
  await mainInput.fill("メインで編集中の下書き");

  await openSavedBranch();
  await expect(
    sideAnswers.getByText("あとで再開する質問", { exact: true }),
  ).toBeVisible();
  await expect(mainInput).toHaveValue("メインで編集中の下書き");
  // HEAD を動かしている間は、状態は見られるが切り替えられない
  await branchSelect.open();
  await expect(
    branchSelect.popup.getByRole("button", {
      name: "あとで再開する質問（元の会話 から分岐）",
    }),
  ).toBeDisabled();
  await branchSelect.close();
  await expect(page).toHaveURL(rootUrl);
  await sideInput.fill("承認が必要な操作をして");
  await sideInput.press("Enter");
  const approval = side.getByRole("region", { name: "ツール実行の承認" });
  await expect(approval).toBeVisible();

  // 承認待ちの会話を閉じてから開き直しても、同じ会話の生成に戻れる。
  await closeSide.click();
  await openSavedBranch();
  await approval.getByRole("button", { name: "許可" }).click();
  await expect(
    sideAnswers.getByText("許可されました", { exact: true }),
  ).toBeVisible();
  await closeSide.click();
  await expect(mainInput).toHaveValue("メインで編集中の下書き");
  await expect(
    main.getByText("この回答の続きとして分岐します。"),
  ).toBeVisible();
  await branchSelect.expectCount(2);
  await expect(page).toHaveURL(rootUrl);

  await newChat(page);
  await page
    .getByRole("navigation", { name: "スレッド一覧" })
    .getByText(firstQuestion, { exact: true })
    .click();
  await expect(page).toHaveURL(rootUrl);
  await expect(main.getByText("了解: 元の会話で進めた話題")).toBeVisible();
});

test("過去の回答をサイドで質問し、狭い画面でもメインの HEAD と下書きを保つ", async ({
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
  await askSelectionIn(main);
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

  // メインとサイドが同じ過去の HEAD から分岐しても、パネルは切り替わらない。
  await page.setViewportSize({ width: 1280, height: 800 });
  await idle(page);
  const rootUrl = page.url();
  await startBranch(
    page,
    main.getByRole("button", { name: "ここから分岐" }).first(),
  );
  await selectAnswerParagraph(main.locator("[data-assistant-message]").first());
  await askSelectionIn(main);
  await input.fill("A の別の脇道");
  await input.press("Enter");
  const sideAnswer = sideAnswers.getByText("A の別の脇道", { exact: true });
  await expect(sideAnswer).toBeVisible();
  await expect(
    main.getByText("この回答の続きとして分岐します。"),
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
  await expect(cache).toHaveText(/^(59|60):\d\d$/);
  const first = await cache.textContent();
  await expect(cache).not.toHaveText(first ?? "", { timeout: 3_000 });

  // 期限は時刻で持つので、リロードしても数え直す
  await page.reload();
  await expect(cache).toHaveText(/^(59|60):\d\d$/);

  await pickModel(page, "Haiku");
  await expect(cache).toHaveText("不明");
  await expect(cache).toHaveAccessibleName(/プロンプトキャッシュ/);
  // 選んだモデルは新規スレッドの初期値になるので、ほかのテストのために戻す
  await pickModel(page, "Default");
});

test("最後に選んだモデルと effort を、新規スレッドの初期値にする（#164）", async ({
  page,
}) => {
  const model = modelButton(page);
  const effort = page.getByRole("combobox", { name: "effort" });
  /** 次の送信で、サーバに送ったモデルと effort。 */
  const sentSettings = async (text: string) => {
    const request = page.waitForRequest((r) => r.url().includes("/chat/send"));
    await send(page, text);
    const body = (await request).postData() ?? "";
    await idle(page);
    return {
      model: /"model":"([^"]+)"/.exec(body)?.[1],
      effort: /"effort":(null|"[^"]+")/.exec(body)?.[1],
    };
  };
  await open(page);
  await createTask(page, "初期値の検証");
  await newChat(page);
  await expect(model).toHaveAttribute("data-model", "default");
  await expect(effort).toHaveValue("");

  // 選んだ組み合わせが、次の新規スレッドの初期値になる
  await effort.selectOption("high");
  await send(page, "既定モデルで高");
  await idle(page);
  const first = new URL(page.url()).pathname;
  await newChat(page);
  await expect(model).toHaveAttribute("data-model", "default");
  await expect(effort).toHaveValue("high");
  // 送らずに選ぶだけでも保存し、再起動（再読み込み）後も引き継ぐ
  await pickModel(page, "Haiku");
  await expect(effort).toHaveCount(0);

  await page.reload();
  await expect(model).toHaveAttribute("data-model", "haiku");
  // 送るとその設定で回答を作る
  expect(await sentSettings("Haiku で")).toEqual({
    model: "haiku",
    effort: "null",
  });

  // 既存のスレッドは、そのスレッドの設定を表示する。開いただけでは初期値を変えない
  await page.goto(first);
  await expect(model).toHaveAttribute("data-model", "default");
  await expect(effort).toHaveValue("high");
  await newChat(page);
  await expect(model).toHaveAttribute("data-model", "haiku");

  // Wiki ページから始める質問にも同じ初期値を使う
  await openWiki(page, "初期値の検証");
  await page.getByRole("button", { name: "新しいノート" }).click();
  await page.getByRole("textbox", { name: "ノートのタイトル" }).fill("初期値");
  await page.getByRole("textbox", { name: "本文（Markdown）" }).fill("本文。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "このノートについて質問" }).click();
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  await expect(modelButton(side)).toHaveAttribute("data-model", "haiku");
  const request = page.waitForRequest((r) => r.url().includes("/wiki/ask"));
  const composer = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  await composer.fill("要約して");
  await composer.press("Enter");
  expect((await request).postData()).toContain('"model":"haiku"');
  await expect(modelButton(side)).toHaveAttribute("data-model", "haiku");

  // ほかのテストのために既定に戻す
  await page.goto(first);
  await effort.selectOption("");
  await expect(effort).toHaveValue("");
});

test("モデル選択の最初の階層にシリーズを並べ、残りは「その他のモデル」から選べる（#183）", async ({
  page,
}) => {
  const model = modelButton(page);
  const effort = page.getByRole("combobox", { name: "effort" });
  const menu = page.getByRole("menu", { name: "モデル", exact: true });
  const others = page.getByRole("menu", { name: "その他のモデル" });
  const sentSettings = async (text: string) => {
    const request = page.waitForRequest((r) => r.url().includes("/chat/send"));
    await send(page, text);
    const body = (await request).postData() ?? "";
    await idle(page);
    return {
      model: /"model":"([^"]+)"/.exec(body)?.[1],
      effort: /"effort":(null|"[^"]+")/.exec(body)?.[1],
    };
  };
  await open(page);
  await newChat(page);

  // 最初の階層には、利用可能なシリーズのエイリアスだけをこの順に並べる
  await model.click();
  await expect(menu.getByRole("menuitemradio")).toHaveText(["Sonnet", "Haiku"]);
  await expect(others).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "その他のモデル" }).click();
  await expect(others.getByRole("menuitemradio")).toHaveText([
    "Default",
    "Opus 4.1",
  ]);
  await expect(
    others.getByRole("menuitemradio", { name: "Default" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(others).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: "その他のモデル" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(model).toBeFocused();

  // キーボードで第 2 階層のバージョン指定のモデルを選ぶ
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitemradio", { name: "Sonnet" }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(
    others.getByRole("menuitemradio", { name: "Opus 4.1" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(model).toHaveText("Opus 4.1");
  await expect(model).toHaveAttribute("data-model", "claude-opus-4-1");
  await effort.selectOption("max");
  expect(await sentSettings("Opus 4.1 で")).toEqual({
    model: "claude-opus-4-1",
    effort: '"max"',
  });

  // 開き直しても、選んだバージョン指定のモデル名を表示する
  await page.reload();
  await expect(model).toHaveText("Opus 4.1");
  await expect(effort).toHaveValue("max");

  // 選択先で使えない effort は既定に戻す
  await pickModel(page, "Sonnet");
  await expect(model).toHaveText("Sonnet");
  await expect(effort).toHaveValue("");
  expect(await sentSettings("Sonnet で")).toEqual({
    model: "sonnet",
    effort: "null",
  });

  // ほかのテストのために既定に戻す
  await pickModel(page, "Default");
  await expect(model).toHaveAttribute("data-model", "default");
});

test("Wiki ページから始めたスレッドに、最初の回答のあとでタイトルを付ける（#161）", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "タイトル生成の検証");
  await openWiki(page, "タイトル生成の検証");
  const createPage = async (title: string) => {
    await page.getByRole("button", { name: "新しいノート" }).click();
    await page.getByRole("textbox", { name: "ノートのタイトル" }).fill(title);
    await page
      .getByRole("textbox", { name: "本文（Markdown）" })
      .fill("本文。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  };
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const composer = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  const ask = async (text: string) => {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(side.getByText(text, { exact: true })).toBeVisible();
    await expect(
      side.getByRole("button", { name: "送信", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  };
  const threads = taskItem(page, "タイトル生成の検証");

  await createPage("個人情報の取扱い");
  await page.getByRole("button", { name: "このノートについて質問" }).click();
  await ask("委託先に渡すと第三者提供？");
  // 生成中はページ名を仮のタイトルにする
  await expect(threads.getByText("個人情報の取扱い")).toBeVisible();
  await expect(
    threads.getByText("委託先に渡すと第三者提供？ の論点"),
  ).toBeVisible({ timeout: 10_000 });
  // サイドチャットの見出しは元のページ名のまま
  await expect(side.locator("header")).toContainText("個人情報の取扱い");
  await expect(
    page.getByRole("heading", { name: "個人情報の取扱い" }),
  ).toBeVisible();

  // 追加の質問では作り直さない。再読み込みしても残る
  await ask("それはなぜ？");
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(
    threads.getByText("委託先に渡すと第三者提供？ の論点"),
  ).toBeVisible();
  await expect(threads.getByText("それはなぜ？ の論点")).toHaveCount(0);

  // 生成に失敗しても、仮のタイトルのまま開ける
  await createPage("委託契約");
  await page.getByRole("button", { name: "このノートについて質問" }).click();
  await ask("タイトル失敗の質問");
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(threads.getByText("委託契約")).toBeVisible();
  await threads.getByText("委託契約").click();
  await expect(
    page.getByText("タイトル失敗の質問", { exact: true }),
  ).toBeVisible();
});

test("ノートから質問したスレッドを開くと、元のノートを示し、そこから開ける", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "元のノートの検証");
  await openWiki(page, "元のノートの検証");
  await page.getByRole("button", { name: "新しいノート" }).click();
  await page
    .getByRole("textbox", { name: "ノートのタイトル" })
    .fill("データ保持方針");
  await page
    .getByRole("textbox", { name: "本文（Markdown）" })
    .fill("保持期間は 3 年。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "データ保持方針" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "このノートについて質問" }).click();
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const composer = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  await composer.fill("保持期間は？");
  await composer.press("Enter");
  await expect(
    side.getByRole("button", { name: "送信", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  // サイドチャットには出さない（見出しにノート名がある）
  await expect(side.getByRole("note", { name: "元のノート" })).toHaveCount(0);

  // スレッドのタイトルが変わっても、メインで開くと元のノートが分かる
  const threads = taskItem(page, "元のノートの検証");
  await expect(threads.getByText("保持期間は？ の論点")).toBeVisible({
    timeout: 10_000,
  });
  await threads.getByText("保持期間は？ の論点").click();
  const main = page.getByRole("region", { name: "メインのチャット" });
  const source = main.getByRole("note", { name: "元のノート" });
  await expect(source).toContainText(
    "ノート データ保持方針 から質問したスレッド",
  );

  // 押すと右側のペインでノートを開く
  await source.getByRole("button", { name: "ノートを開く" }).click();
  const pane = page.getByRole("complementary", { name: "ノート" });
  await expect(pane.getByText("保持期間は 3 年。")).toBeVisible();

  // ふつうのスレッドには出さない
  await newChat(page);
  await expect(main.getByRole("note", { name: "元のノート" })).toHaveCount(0);
});

test("環境に説明を付けて、設定で確かめて変えられる（#160）", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "新しい環境", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新しい環境" });
  await create.getByRole("textbox", { name: "環境の名前" }).fill("個人情報");
  await create
    .getByRole("textbox", { name: "環境の説明" })
    .fill("個人情報の取扱いを検討する");
  await create.getByRole("button", { name: "/e2e を外す" }).click();
  await create.getByRole("button", { name: "選ぶ" }).click();
  await create.getByRole("button", { name: "作成" }).click();
  await expect(create).toHaveCount(0);

  const description = page
    .getByRole("dialog", { name: "環境の設定" })
    .getByRole("textbox", { name: "環境の説明" });
  await openEnvironmentMenu(page, "個人情報", "環境の設定");
  await expect(description).toHaveValue("個人情報の取扱いを検討する");
  await description.fill("仮名加工情報の使い方を検討する");
  await page
    .getByRole("dialog", { name: "環境の設定" })
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(description).toHaveCount(0);

  // 開き直しても、保存した説明が出る
  await page.reload();
  await openEnvironmentMenu(page, "個人情報", "環境の設定");
  await expect(description).toHaveValue("仮名加工情報の使い方を検討する");
});

test("Wiki を使わない環境を作り、あとから Wiki を使うように変えられる（#232）", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "新しい環境", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新しい環境" });
  await create.getByRole("textbox", { name: "環境の名前" }).fill("下調べ");
  await create.getByRole("button", { name: "/e2e を外す" }).click();
  await create.getByRole("button", { name: "選ぶ" }).click();
  await create.getByRole("radio", { name: "Wiki を使わない" }).check();
  await create.getByRole("button", { name: "作成" }).click();
  await expect(create).toHaveCount(0);
  const wikiAction = environmentRow(page, "下調べ").getByRole("button", {
    name: "環境「下調べ」の Wiki を開く",
  });

  // タスクを作るときに、Wiki を参照しないことが分かる
  await page.getByRole("button", { name: "新しいタスク", exact: true }).click();
  await page.getByRole("textbox", { name: "タスクの名前" }).fill("競合調査");
  await page
    .getByRole("combobox", { name: "タスクの環境" })
    .selectOption({ label: "下調べ" });
  await expect(page.getByText("Wiki は参照しません。")).toBeVisible();
  await page.getByRole("button", { name: "作成" }).click();
  await expect(page).toHaveURL(/\/t\/.+/);

  // Wiki への入口を出さない
  await expect(
    page.getByRole("button", { name: "新しいスレッド", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Wiki を開く" })).toHaveCount(
    0,
  );
  await environmentRow(page, "下調べ").hover();
  await expect(wikiAction).toHaveCount(0);
  // Wiki の URL を直接開いても、Wiki は出さない
  await page.goto(`${new URL(page.url()).pathname}/wiki`);
  await expect(
    page.getByText("このタスクの環境は Wiki を使っていません。"),
  ).toBeVisible();

  // 設定で新しい Wiki を作って使うと、Wiki を開ける
  await openEnvironmentMenu(page, "下調べ", "環境の設定");
  const settings = page.getByRole("dialog", { name: "環境の設定" });
  await expect(
    settings.getByRole("radio", { name: "Wiki を使わない" }),
  ).toBeChecked();
  await settings.getByRole("radio", { name: "新しい Wiki を作る" }).check();
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await rowAction(
    environmentRow(page, "下調べ"),
    "環境「下調べ」の Wiki を開く",
  );
  await expect(
    page.getByRole("button", { name: "新しいノート" }),
  ).toBeVisible();

  // 使わないように戻すと、設定では既存の Wiki から選び直せる
  await openEnvironmentMenu(page, "下調べ", "環境の設定");
  await expect(
    settings.getByRole("radio", { name: "既存の Wiki を使う" }),
  ).toBeChecked();
  await settings.getByRole("radio", { name: "Wiki を使わない" }).check();
  await expect(
    settings.getByText("今の Wiki とノートは消えずに残り"),
  ).toBeVisible();
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await environmentRow(page, "下調べ").hover();
  await expect(wikiAction).toHaveCount(0);
});

test("サイドチャットの用語もサイドパネルで開き、閉じると入力途中のサイドチャットに戻る（#168）", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "サイドの用語");
  await openWiki(page, "サイドの用語");
  await page.getByRole("button", { name: "新しいノート" }).click();
  await page.getByRole("textbox", { name: "ノートのタイトル" }).fill("方式B");
  await page
    .getByRole("textbox", { name: "本文（Markdown）" })
    .fill("非同期で処理する方式。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "方式B" })).toBeVisible();
  const wikiUrl = page.url();

  const main = page.getByRole("main");
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const sideInput = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  const pane = page.getByRole("complementary", { name: "ノート" });
  const card = page.getByRole("dialog", { name: "用語の説明" });

  // Wiki ページから質問したサイドチャット: 用語を押すと本文を重ねて開き、閉じると戻る
  await page.getByRole("button", { name: "このノートについて質問" }).click();
  await sideInput.fill("方式B とは");
  await sideInput.press("Enter");
  const sideTerm = side.locator("button[data-wiki-term]", {
    hasText: "方式B",
  });
  await expect(sideTerm.first()).toBeVisible({ timeout: 15_000 });
  await sideInput.fill("書きかけの質問");
  await sideTerm.first().click();
  await expect(pane).toContainText("非同期で処理する方式。");
  await expect(side).toBeHidden();
  expect(page.url()).toBe(wikiUrl);
  await pane.getByRole("button", { name: "ノートを閉じる" }).click();
  await expect(pane).toHaveCount(0);
  await expect(side).toBeVisible();
  await expect(sideInput).toHaveValue("書きかけの質問");

  // 分岐のサイドチャット: 要約の「サイドパネルで開く」でも開け、「Wiki で開く」で Wiki 画面へ移る
  await openTask(page, "サイドの用語");
  await newChat(page);
  await send(page, "方式A と 方式B の比較");
  await idle(page);
  const chatUrl = page.url();
  await selectLastAnswerParagraph(page);
  await askSelectionIn(main);
  await sideInput.fill("方式B の弱点は？");
  await sideInput.press("Enter");
  await expect(sideTerm.last()).toBeVisible({ timeout: 15_000 });
  await sideInput.fill("分岐の書きかけ");
  await sideTerm.last().click();
  await expect(pane).toContainText("非同期で処理する方式。");
  await expect(side).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await expect(sideInput).toHaveValue("分岐の書きかけ");

  await sideTerm.last().hover();
  await card.getByRole("button", { name: "サイドパネルで開く" }).click();
  await expect(pane).toContainText("非同期で処理する方式。");
  expect(page.url()).toBe(chatUrl);
  await pane.getByRole("button", { name: "Wiki で開く" }).click();
  await expect(page).toHaveURL(/\/wiki\/.+/);
  await expect(page.getByRole("heading", { name: "方式B" })).toBeVisible();
});

test("Wiki ページへの質問と回答から Q&A を作り、ページの下に出す（#159）", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "Q&A の検証");
  await openWiki(page, "Q&A の検証");
  const createPage = async (title: string) => {
    await page.getByRole("button", { name: "新しいノート" }).click();
    await page.getByRole("textbox", { name: "ノートのタイトル" }).fill(title);
    await page
      .getByRole("textbox", { name: "本文（Markdown）" })
      .fill("本文。");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  };
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const composer = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  const ask = async (text: string) => {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(side.getByText(text, { exact: true })).toBeVisible();
    await expect(
      side.getByRole("button", { name: "送信", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  };
  const qas = page.getByRole("region", { name: "Q&A" }).getByRole("listitem");

  await createPage("委託");
  const pageUrl = page.url();
  await expect(qas).toHaveCount(0);
  await page.getByRole("button", { name: "このノートについて質問" }).click();
  await ask("委託先に渡すと第三者提供？");
  await expect(qas).toHaveCount(1, { timeout: 10_000 });
  await expect(qas.first()).toContainText("Q: 委託先に渡すと第三者提供？");
  await qas.first().getByRole("button", { name: "回答を開く" }).click();
  await expect(qas.first()).toContainText("文字の回答の要約");

  // 文脈に依存する追加の質問は、何を指すかを補った Q&A になる
  await ask("それはなぜ？");
  await expect(qas).toHaveCount(2, { timeout: 10_000 });
  await expect(qas.nth(1)).toContainText(
    "Q: それはなぜ？（委託先に渡すと第三者提供？ について）",
  );

  // 作成に失敗しても、会話と既存の Q&A はそのまま
  await ask("Q&A失敗する質問");
  await page.waitForTimeout(1500);
  await expect(qas).toHaveCount(2);
  await expect(
    side.getByText("Q&A失敗する質問", { exact: true }),
  ).toBeVisible();

  // サイドチャットを閉じて開き直しても残り、別のページには混ざらない
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();
  await page.reload();
  await expect(qas).toHaveCount(2);
  await createPage("別のページ");
  await expect(qas).toHaveCount(0);
  await page.goto(pageUrl);
  await expect(qas).toHaveCount(2);
});

test("ノートの Q&A は質問だけを並べ、項目ごとに回答と元のスレッドへのリンクを開閉する（#205）", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "Q&A 開閉");
  await openWiki(page, "Q&A 開閉");
  for (const [title, body] of [
    ["第三者提供", "本人以外に個人データを渡すこと。"],
    ["委託", "業務を外部に任せること。"],
  ] as const) {
    await page.getByRole("button", { name: "新しいノート" }).click();
    await page.getByRole("textbox", { name: "ノートのタイトル" }).fill(title);
    await page.getByRole("textbox", { name: "本文（Markdown）" }).fill(body);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  const noteUrl = page.url();
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const composer = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  const ask = async (text: string) => {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(side.getByText(text, { exact: true })).toBeVisible();
    await expect(
      side.getByRole("button", { name: "送信", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  };
  const qas = page.getByRole("region", { name: "Q&A" }).getByRole("listitem");
  const answerOf = (index: number) =>
    qas.nth(index).getByText("文字の回答の要約");
  const toggleOf = (index: number) =>
    qas.nth(index).getByRole("button", { name: /^回答を(開く|閉じる)$/ });

  await page.getByRole("button", { name: "このノートについて質問" }).click();
  await ask("第三者提供にあたる？");
  await expect(qas).toHaveCount(1, { timeout: 10_000 });

  // 開いた直後は質問だけ。ボタンで回答とリンクを開閉できる（キーボードでも）
  await expect(qas.first()).toContainText("Q: 第三者提供にあたる？");
  await expect(answerOf(0)).toHaveCount(0);
  await expect(toggleOf(0)).toHaveAttribute("aria-expanded", "false");
  await toggleOf(0).click();
  await expect(answerOf(0)).toBeVisible();
  await expect(
    qas.first().getByRole("button", { name: "元のスレッドを開く" }),
  ).toBeVisible();
  await toggleOf(0).press("Enter");
  await expect(answerOf(0)).toHaveCount(0);
  await toggleOf(0).press("Space");
  await expect(answerOf(0)).toBeVisible();

  // 新しい Q&A が足されても、開いた項目は開いたまま。新しい項目は閉じている
  await ask("第三者提供との違いは？");
  await expect(qas).toHaveCount(2, { timeout: 10_000 });
  await expect(answerOf(0)).toBeVisible();
  await expect(toggleOf(1)).toHaveAttribute("aria-expanded", "false");
  await expect(answerOf(1)).toHaveCount(0);
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();

  // Q と A の用語（閲覧中のノート自身は除く）に下線。閉じた Q の用語を押しても、開閉状態は変わらない
  const qTerm = qas
    .nth(1)
    .locator("[data-wiki-qa] button[data-wiki-term]", {
      hasText: "第三者提供",
    })
    .first();
  await expect(qTerm).toBeVisible();
  await qTerm.hover();
  await expect(page.getByRole("dialog", { name: "用語の説明" })).toContainText(
    "本人以外に個人データを渡すこと。",
  );
  await qTerm.click();
  const pane = page.getByRole("complementary", { name: "ノート" });
  await expect(pane.getByRole("heading", { name: "第三者提供" })).toBeVisible();
  await expect(toggleOf(1)).toHaveAttribute("aria-expanded", "false");
  await expect(answerOf(0)).toBeVisible();
  await pane.getByRole("button", { name: "ノートを閉じる" }).click();
  await expect(pane).toHaveCount(0);

  // 閉じた Q の文を選んでも開閉状態は変わらず、選択部分を引用して質問できる
  const popup = page.getByRole("toolbar", { name: "選択範囲の操作" });
  await selectAnswerText(qas.nth(1).locator("[data-wiki-qa]"), "との違い");
  await expect(popup).toBeVisible();
  await expect(toggleOf(1)).toHaveAttribute("aria-expanded", "false");
  await popup.getByRole("button", { name: "質問", exact: true }).click();
  await expect(side.locator("blockquote")).toHaveText("との違い");
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();

  // A の語句から、その Q&A を参照資料にしてノートを作れる
  await selectAnswerText(
    qas.nth(0).locator("[data-wiki-qa]").last(),
    "回答の要約",
  );
  await popup.getByRole("button", { name: "ノートを作成" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "「回答の要約」のノートを作成しました。" }),
  ).toBeVisible();
  await expect(answerOf(0)).toBeVisible();

  // リンクから元のスレッドを開き、対応する回答へ移る
  await qas.first().getByRole("button", { name: "元のスレッドを開く" }).click();
  await expect(page).toHaveURL(/\/c\/.+/);
  const main = page.getByRole("region", { name: "メインのチャット" });
  await expect(
    main.getByText("第三者提供にあたる？", { exact: true }),
  ).toBeVisible();
  await page.goto(noteUrl);
  await expect(qas).toHaveCount(2);
  await expect(answerOf(0)).toHaveCount(0);
});

test("ノートの変更履歴・差分・復元、元に戻す / やり直す、回答ごとの取り消し、チェックポイント（#166）", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "履歴の検証");
  const body = page.locator("[data-wiki-page-body]");
  const openNote = async (title: string) => {
    await openWiki(page, "履歴の検証");
    await page
      .getByRole("list", { name: "ノート" })
      .getByRole("button", { name: title })
      .click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  };
  const editBody = async (text: string) => {
    await page.getByRole("button", { name: "編集", exact: true }).click();
    await page.getByRole("textbox", { name: "本文（Markdown）" }).fill(text);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(body).toHaveText(text);
  };

  // 利用者の作成・編集が版として残り、差分を見て任意の版に復元できる
  await openWiki(page, "履歴の検証");
  await page.getByRole("button", { name: "新しいノート" }).click();
  await page.getByRole("textbox", { name: "ノートのタイトル" }).fill("委託");
  await page.getByRole("textbox", { name: "本文（Markdown）" }).fill("v1");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(body).toHaveText("v1");
  await editBody("v2");
  await page.getByRole("button", { name: "履歴", exact: true }).click();
  const history = page.getByRole("region", { name: "変更履歴" });
  const versions = history.getByRole("list", { name: "版の一覧" });
  await expect(versions.getByRole("listitem")).toHaveCount(2);
  await expect(versions.getByRole("listitem").first()).toContainText(
    "あなたの編集",
  );
  const diff = history.getByTestId("wiki-diff");
  await expect(diff.locator('[data-diff="remove"]')).toHaveText("- v1");
  await expect(diff.locator('[data-diff="add"]')).toHaveText("+ v2");
  await versions
    .getByRole("listitem")
    .last()
    .getByRole("button", { name: /の版に復元$/ })
    .click();
  await expect(body).toHaveText("v1");
  await expect(versions.getByRole("listitem")).toHaveCount(3);
  await expect(versions.getByRole("listitem").first()).toContainText("復元");

  // Wiki 画面で元に戻す・やり直す
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(body).toHaveText("v2");
  await page.getByRole("button", { name: "やり直す", exact: true }).click();
  await expect(body).toHaveText("v1");

  // チェックポイントを作る
  await page.getByRole("button", { name: "チェックポイント" }).click();
  const checkpoints = page.getByRole("dialog", { name: "チェックポイント" });
  await checkpoints
    .getByRole("textbox", { name: "チェックポイントの名前" })
    .fill("整理する前");
  await checkpoints.getByRole("button", { name: "今の状態を残す" }).click();
  await expect(checkpoints.getByRole("listitem")).toHaveCount(1);
  await checkpoints.getByRole("button", { name: "閉じる" }).click();

  // Claude が回答の中で Wiki を変えると、回答ごとにまとめて元に戻せる（前に自動でチェックポイントができる）
  await openTask(page, "履歴の検証");
  await newChat(page);
  const main = page.getByRole("main");
  const undoAnswer = main.getByRole("button", {
    name: "この回答での Wiki の変更を元に戻す",
  });
  await send(page, "Wiki に書く: 委託|Claude が書いた");
  await idle(page);
  await expect(undoAnswer).toHaveCount(1);
  await send(page, "Wiki に書く: 新語|新しいノート");
  await idle(page);
  const chatUrl = page.url();
  await undoAnswer.last().click();
  await expect(
    main.getByRole("button", { name: "この回答での Wiki の変更をやり直す" }),
  ).toBeVisible();
  await openWiki(page, "履歴の検証");
  await expect(
    page.getByRole("list", { name: "ノート" }).getByRole("button", {
      name: "新語",
    }),
  ).toHaveCount(0);
  await openNote("委託");
  await expect(body).toHaveText("Claude が書いた");
  await page.getByRole("button", { name: "履歴", exact: true }).click();
  await expect(versions.getByRole("listitem").first()).toContainText(
    "Claude（書き換え）",
  );
  await expect(
    versions.getByRole("button", { name: "元の回答を開く" }).first(),
  ).toBeVisible();

  // 後から別の変更が入ったノートは、回答の取り消しで上書きしない
  await editBody("あとからの編集");
  await page.goto(chatUrl);
  // 前の回答は閉じているので開く
  await main.getByRole("button", { name: "回答を開く" }).first().click();
  await expect(undoAnswer.first()).toBeVisible();
  await undoAnswer.first().click();
  await expect(main.getByRole("alert")).toContainText("上書きしないように");
  await openNote("委託");
  await expect(body).toHaveText("あとからの編集");

  // 削除したノートも履歴から復元できる
  await page.getByRole("button", { name: "ノートを削除" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "削除", exact: true })
    .click();
  await page.getByText("削除したノート（1）").click();
  await page
    .getByRole("list", { name: "削除したノート" })
    .getByRole("button", { name: "委託" })
    .click();
  await expect(page.getByText("このノートは削除されています。")).toBeVisible();
  await page.getByRole("button", { name: "削除前に復元" }).click();
  await expect(body).toHaveText("あとからの編集");

  // チェックポイントへ戻すと Wiki 全体がその時点に戻り（追加・削除を含む）、元に戻せる
  await page.getByRole("button", { name: "チェックポイント" }).click();
  await expect(checkpoints.getByText("自動", { exact: true })).toHaveCount(2);
  await checkpoints
    .getByRole("button", { name: "「整理する前」の時点に戻す" })
    .click();
  await expect(checkpoints.getByRole("status")).toContainText(
    "「整理する前」の時点に戻しました",
  );
  await checkpoints.getByRole("button", { name: "閉じる" }).click();
  await expect(body).toHaveText("v1");
  await page.getByRole("button", { name: "元に戻す", exact: true }).click();
  await expect(body).toHaveText("あとからの編集");
});

test("スレッドをタイトルと本文で検索し、一致した発言へ移動できる", async ({
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
  const box = page.getByRole("searchbox", { name: "スレッドを検索" });
  const results = page.getByRole("navigation", { name: "スレッドの検索結果" });
  await expect(box).toBeHidden();
  await page.getByRole("button", { name: "スレッドを検索" }).click();
  await expect(box).toBeFocused();
  await box.fill("小器官");
  // ユーザー発言と、それを繰り返す回答
  await expect(results.locator("mark", { hasText: "小器官" })).toHaveCount(2);
  await expect(
    page.getByRole("navigation", { name: "スレッド一覧" }),
  ).toBeHidden();
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
    page.getByRole("navigation", { name: "スレッド一覧" }),
  ).toBeVisible();
  await expect(box).toBeHidden();
  await expect(
    page.getByRole("button", { name: "スレッドを検索" }),
  ).toBeFocused();
});

test("回答のあとに、週間の利用枠とリセット時刻をメインの入力欄の下に出す（#170）", async ({
  page,
}) => {
  await open(page);
  await newChat(page);
  await send(page, "利用枠");
  await idle(page);
  // ヘッダーではなく、メインのチャットの入力欄の下に出す
  const mainChat = page.getByRole("region", { name: "メインのチャット" });
  const badge = mainChat.getByTestId("rate-limit");
  await expect(badge).toHaveText(/7 日間枠 67%・\d+\/\d+ \d+:\d\d にリセット/);
  await expect(
    page.locator("main header").getByTestId("rate-limit"),
  ).toHaveCount(0);
  // 押すと、5 時間枠などを含む詳細を開く
  await badge.click();
  const details = page.getByRole("dialog", { name: "利用枠の詳細" });
  await expect(details).toContainText("5 時間枠: 62%");
  await expect(details).toContainText("7 日間枠: 67%");
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
});

test("左上の「設定」→「一般」で Claude Code の情報とテーマを確かめて変えられる（#170）", async ({
  page,
}) => {
  await open(page);
  await newChat(page);
  const chatUrl = page.url();
  const input = page.getByRole("textbox", { name: "メッセージ", exact: true });
  await input.fill("書きかけ");
  // ヘッダーにはバージョンもテーマの切り替えも出さない
  await expect(page.locator("main header")).not.toContainText("0.0.0-e2e");
  await expect(
    page.getByRole("button", { name: "テーマを切り替える" }),
  ).toHaveCount(0);

  await page
    .getByRole("complementary", { name: "サイドバー" })
    .getByRole("button", { name: "設定" })
    .click();
  await page.getByRole("menuitem", { name: "一般" }).click();
  const general = page.getByRole("dialog", { name: "一般" });
  await expect(general).toContainText("バージョン0.0.0-e2e");
  await expect(general).toContainText("契約プランE2E");
  await general.getByRole("radio", { name: "ダーク" }).check();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await general.getByRole("button", { name: "閉じる" }).click();
  await expect(general).toHaveCount(0);
  // 元の会話を開いたまま、入力を続けられる
  expect(page.url()).toBe(chatUrl);
  await expect(input).toHaveValue("書きかけ");

  // テーマは再起動（再読み込み）後も使う
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page
    .getByRole("complementary", { name: "サイドバー" })
    .getByRole("button", { name: "設定" })
    .click();
  await page.getByRole("menuitem", { name: "一般" }).click();
  await expect(general.getByRole("radio", { name: "ダーク" })).toBeChecked();
  await general.getByRole("radio", { name: "ライト" }).check();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

/**
 * 回答の選択ポップアップの「質問」から、続ける先を選ぶ（#222）。
 * 既定は、選んだ回答を起点に新しいサイドチャットで質問する。
 */
const askSelectionIn = async (
  scope: Page | Locator,
  choice = "サイドチャットで質問",
) => {
  const popup = scope.getByRole("toolbar", { name: "選択範囲の操作" });
  await popup.getByRole("button", { name: "質問", exact: true }).click();
  await popup
    .getByRole("menu", { name: "引用して続ける先" })
    .getByRole("menuitem", { name: choice })
    .click();
};

/** CSS Custom Highlight API で引いた範囲の文字（#239）。 */
const highlightTexts = (page: Page, name: string) =>
  page.evaluate(
    (highlight) =>
      [...(CSS.highlights.get(highlight) ?? [])].map((range) =>
        (range as Range).toString(),
      ),
    name,
  );

test("サイドチャットの引用からメインの引用元へ移れ、メインの回答の引用した箇所からサイドチャットを開ける（#239）", async ({
  page,
}) => {
  await open(page);
  const main = page.getByRole("main");
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const sideInput = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  const closeSide = side.getByRole("button", {
    name: "サイドチャットを閉じる",
  });
  const branches = branchMenu(page);

  await newChat(page);
  await send(page, "最初の話題");
  await idle(page);
  await send(page, "引用元を探す質問");
  await idle(page);

  // 回答の一部を引用してサイドチャットで質問する
  await selectAnswerText(
    page.locator("[data-assistant-message]").last(),
    "探す質問",
  );
  await askSelectionIn(page);
  await sideInput.fill("どういう意味？");
  await sideInput.press("Enter");
  await expect(side.getByText(/^了解: 以下は/)).toBeVisible();

  // メインの回答の、引用した箇所に下線を引く
  await expect
    .poll(() => highlightTexts(page, "monet-side-quote"))
    .toEqual(["探す質問"]);
  await closeSide.click();
  await expect(side).toHaveCount(0);

  // 下線を押すと、そのサイドチャットを開く
  const point = await page.evaluate(() => {
    const range = [
      ...(CSS.highlights.get("monet-side-quote") ?? []),
    ][0] as Range;
    range.startContainer.parentElement?.scrollIntoView({ block: "center" });
    const rect = range.getClientRects()[0];
    if (rect === undefined) throw new Error("no rect");
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await expect(side.getByText(/^了解: 以下は/)).toBeVisible();

  // サイドチャットの引用から、メインの引用元を示す
  await side.getByRole("button", { name: "引用元を表示" }).click();
  await expect
    .poll(() => highlightTexts(page, "monet-quote-focus"))
    .toEqual(["探す質問"]);
  await expect
    .poll(() => highlightTexts(page, "monet-quote-focus"), { timeout: 5000 })
    .toEqual([]);
  await closeSide.click();

  // 引用元より前から分岐した会話をメインで開いていると、引用元の会話を開けるよう知らせる
  await main.getByRole("button", { name: "回答を開く" }).first().click();
  await main.getByRole("button", { name: "ここから分岐" }).first().click();
  await send(page, "別の流れ");
  await idle(page);
  await expect(branches.trigger).toContainText("別の流れ");
  await branches.openSide("どういう意味？");
  await side.getByRole("button", { name: "引用元を表示" }).click();
  await expect(side.getByRole("status")).toContainText(
    "引用元は、メインで開いている会話にありません。",
  );
  await side
    .getByRole("button", { name: "引用元の会話をメインで開く" })
    .click();
  await expect(branches.trigger).toContainText("元の会話");
  await expect
    .poll(() => highlightTexts(page, "monet-quote-focus"))
    .toEqual(["探す質問"]);
});

/** 回答の中の text と一致する文字だけを選ぶ。用語の下線などで要素が分かれていても選べる。 */
const selectAnswerText = (answer: Locator, text: string) =>
  answer.evaluate((root, target) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: { node: Node; start: number }[] = [];
    let all = "";
    for (
      let node = walker.nextNode();
      node !== null;
      node = walker.nextNode()
    ) {
      nodes.push({ node, start: all.length });
      all += node.textContent ?? "";
    }
    const at = all.indexOf(target);
    if (at < 0) throw new Error(`text not found: ${target}`);
    const locate = (offset: number, end: boolean) => {
      const found = nodes.findLast(({ node, start }) =>
        end
          ? start < offset && offset <= start + (node.textContent?.length ?? 0)
          : start <= offset,
      );
      if (found === undefined) throw new Error(`text not found: ${target}`);
      return { node: found.node, offset: offset - found.start };
    };
    const from = locate(at, false);
    const to = locate(at + target.length, true);
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, text);

test("回答の選択範囲から AI で Wiki のページを作り、チャットに留まったまま用語として表示する", async ({
  page,
}) => {
  await open(page);
  const main = page.getByRole("main");
  const popup = main.getByRole("toolbar", { name: "選択範囲の操作" });
  const createPage = popup.getByRole("button", { name: "ノートを作成" });
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
  // 背景の光が流れる（@keyframes がバンドル後も残っている。#165）
  const glowPosition = () =>
    generating.evaluate((el) => getComputedStyle(el).backgroundPosition);
  const firstPosition = await glowPosition();
  await expect.poll(glowPosition, { timeout: 800 }).not.toBe(firstPosition);
  // 動きを減らす設定では、止まった背景色で作成中と分かる
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await generating.evaluate((el) => {
    const style = getComputedStyle(el);
    return { animation: style.animationName, color: style.backgroundColor };
  });
  expect(reduced.animation).toBe("none");
  expect(reduced.color).not.toBe("rgba(0, 0, 0, 0)");
  await page.emulateMedia({ reducedMotion: null });
  await expect(page).toHaveURL(new RegExp(`${chatPath}$`));
  const term = main.locator("button[data-wiki-term]", {
    hasText: "冪等性キー",
  });
  await expect(term).toBeVisible();
  await expect(generating).toHaveCount(0);
  await expect(messageInput).toHaveValue("まだ送っていない質問");
  // 用語をクリックすると、作ったページが右側のペインで開く
  await term.click();
  const pane = page.getByRole("complementary", { name: "ノート" });
  await expect(pane).toContainText("冪等性キー は回答に出てきた語。");
  await pane.getByRole("button", { name: "ノートを閉じる" }).click();
  await expect(pane).toHaveCount(0);

  // 同じ名前のページがあれば、作らずに知らせる
  await selectAnswerText(lastAnswer, "冪等性キー");
  await createPage.click();
  await expect(
    main.getByRole("status").filter({
      hasText: "「冪等性キー」のノートはすでにあります。",
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
      hasText: "「失敗する語句」のノートを作成できませんでした。",
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
    page.getByText("回答から自動で作成したノートです"),
  ).toBeVisible();
  await expect(page.getByText("生成したページ。")).toBeVisible();
});

test("Wiki の個別ページで質問し、リロードやページ削除のあとも履歴を開ける", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "ページ質問の検証");
  await openWiki(page, "ページ質問の検証");
  await page.getByRole("button", { name: "新しいノート" }).click();
  const title = "委譲手順";
  await page.getByRole("textbox", { name: "ノートのタイトル" }).fill(title);
  await page
    .getByRole("textbox", { name: "本文（Markdown）" })
    .fill("管理者に確認する。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const url = page.url();

  const ask = page.getByRole("button", { name: "このノートについて質問" });
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

  await page.getByRole("button", { name: "ノートを削除" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "削除", exact: true })
    .click();
  // 削除したノートは変更履歴から復元できる（#180）
  await expect(
    page.getByText("このノートは削除されています。変更履歴から復元できます。"),
  ).toBeVisible();
  await close.click();
  await page.reload();
  await page.getByRole("button", { name: "質問の履歴を開く" }).click();
  await expect(side.getByText("具体的には？", { exact: true })).toBeVisible();
  await send("削除後の質問");
  await expect(side.getByRole("alert")).toContainText(
    "このノートを参照できません",
  );
});

test("Wiki ページの本文の選択範囲から、ページを作ったり引用して質問したりできる", async ({
  page,
}) => {
  await open(page);
  await createTask(page, "本文選択の検証");
  await openWiki(page, "本文選択の検証");
  await page.getByRole("button", { name: "新しいノート" }).click();
  await page
    .getByRole("textbox", { name: "ノートのタイトル" })
    .fill("決済 API");
  await page
    .getByRole("textbox", { name: "本文（Markdown）" })
    .fill("決済 API は冪等性キーを受け取る。\n\n再送しても二重に課金しない。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "決済 API" })).toBeVisible();
  const url = page.url();
  const body = page.locator("[data-wiki-page-body]");
  const popup = page.getByRole("toolbar", { name: "選択範囲の操作" });

  // 語句を選んでページを作ると、画面を移らずに知らせ、作ったページを開ける
  await selectAnswerText(body, "冪等性キー");
  await popup.getByRole("button", { name: "ノートを作成" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "のノートを作成しています" }),
  ).toBeVisible();
  const created = page
    .getByRole("status")
    .filter({ hasText: "「冪等性キー」のノートを作成しました。" });
  await expect(created).toBeVisible();
  await expect(page).toHaveURL(url);
  await expect(
    page
      .getByRole("navigation", { name: "ノート一覧" })
      .getByRole("button", { name: "冪等性キー" }),
  ).toBeVisible();
  await created.getByRole("button", { name: "開く" }).click();
  await expect(page.getByRole("heading", { name: "冪等性キー" })).toBeVisible();
  await expect(page.getByText("冪等性キー は回答に出てきた語。")).toBeVisible();

  // 選んだ部分を引用して質問すると、引用付きでサイドチャットに送れる
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "決済 API" })).toBeVisible();
  await selectAnswerText(body, "二重に課金しない");
  await popup.getByRole("button", { name: "質問" }).click();
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const composer = side.getByRole("textbox", {
    name: "サイドチャットのメッセージ",
  });
  await expect(side.locator("blockquote")).toHaveText("二重に課金しない");
  await expect(composer).toBeFocused();
  await composer.fill("なぜ？");
  await composer.press("Enter");
  // 回答のあとに同じ文言の段落（ノートの Q&A など）も出ることがあるので、最初の 1 つで確かめる
  await expect(side.getByText("なぜ？", { exact: true }).first()).toBeVisible();
  await expect(side.locator("blockquote")).toHaveText("二重に課金しない");
  await expect(side.locator("a[data-wiki-page]:visible")).toHaveText(
    "決済 API",
  );

  // 開いたまま別の部分を選ぶと、次の質問に添える引用になり、外すこともできる
  await selectAnswerText(body, "冪等性キーを受け取る");
  await popup.getByRole("button", { name: "質問" }).click();
  await expect(side.locator("blockquote")).toHaveCount(2);
  await expect(side.locator("blockquote").last()).toHaveText(
    "冪等性キーを受け取る",
  );
  await expect(composer).toBeFocused();
  await side.getByRole("button", { name: "引用を外す" }).click();
  await expect(side.locator("blockquote")).toHaveCount(1);
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
  await page.getByRole("button", { name: "新しいノート" }).click();
  await page
    .getByRole("textbox", { name: "ノートのタイトル" })
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

  // 同じページが見え、概要から参照しているタスクが分かる（#213）
  await openWiki(page, "共有元");
  await expect(page.getByRole("button", { name: "共有用語" })).toBeVisible();
  const header = page.locator("main > header");
  await header.getByRole("button", { name: "Wiki の概要" }).click();
  const overview = page.getByRole("dialog", { name: "Wiki の概要" });
  await expect(overview).toContainText(
    "回答からの用語ノートの自動作成: オン（タスクの設定で変更できます）",
  );
  const referencing = overview.getByRole("list", {
    name: "この Wiki を参照しているタスク",
  });
  await expect(referencing).toHaveCount(0);
  await overview
    .getByRole("button", { name: "2件の参照しているタスクがあります" })
    .click();
  await expect(referencing.getByRole("button")).toHaveText([
    "共有元",
    "共有先",
  ]);
  // 押すとそのタスクを開く
  await referencing.getByRole("button", { name: "共有先" }).click();
  await expect(overview).toHaveCount(0);
  await expect(header).toContainText("共有先");
  await expect(header.getByRole("button", { name: "Wiki の概要" })).toHaveCount(
    0,
  );
  await openWiki(page, "共有元");
  // 操作ボタンはヘッダーの右側に並び、本文側の見出しと説明は出さない
  for (const name of [
    "元に戻す",
    "やり直す",
    "チェックポイント",
    "新しいノート",
  ]) {
    await expect(header.getByRole("button", { name })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Wiki: 共有元" })).toHaveCount(
    0,
  );
  await expect(page.getByText("と共有している Wiki")).toHaveCount(0);

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
  // 入力欄の下に環境名を出し、詳細に選んだディレクトリが出る（#192）
  const mainChat = page.getByRole("region", { name: "メインのチャット" });
  await mainChat
    .getByRole("button", { name: "環境: 共通環境（詳細を開く）" })
    .click();
  await expect(
    mainChat.getByRole("dialog", { name: "環境「共通環境」の詳細" }),
  ).toContainText(`${picked}（既定の作業ディレクトリ）`);
  await page.keyboard.press("Escape");

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
    page.getByText("Wiki「共通用語集」とそのノートも削除されます。", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await expect(environmentRow(page, "共通環境")).toHaveCount(0);
});

test("⌘K（Ctrl+K）でコマンドパレットを開き、絞り込んだ操作をキーボードとクリックで実行できる（#243）", async ({
  page,
}) => {
  await open(page);
  const palette = page.getByRole("dialog", { name: "コマンドパレット" });
  const search = palette.getByRole("combobox", { name: "コマンドを検索" });
  const options = palette.getByRole("option");
  const mainInput = page
    .getByRole("region", { name: "メインのチャット" })
    .getByRole("textbox", { name: "メッセージ", exact: true });
  const sidebar = page.getByRole("complementary", { name: "サイドバー" });

  // 入力途中のメッセージがあっても開け、Esc で閉じると入力欄に戻って内容が残る
  await newChat(page);
  await mainInput.fill("入力途中のメッセージ");
  await mainInput.press("ControlOrMeta+K");
  await expect(palette).toBeVisible();
  await expect(search).toBeFocused();
  await expect(options).toHaveText([
    "新しいスレッド",
    "スレッドを検索",
    "タスク一覧",
    "新しいタスク",
  ]);
  await search.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(mainInput).toBeFocused();
  await expect(mainInput).toHaveValue("入力途中のメッセージ");

  // 左ペインを閉じていても開ける。語句で絞り込み、上下キーと Enter だけで実行する
  await page.getByRole("button", { name: "サイドバーを閉じる" }).click();
  await expect(sidebar).toBeHidden();
  await page.keyboard.press("ControlOrMeta+K");
  await search.fill("タスク");
  await expect(options).toHaveText(["タスク一覧", "新しいタスク"]);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowUp");
  await search.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/\/tasks$/);

  // タスク一覧から「新しいタスク」を実行すると、タスクの作成を始める
  await page.keyboard.press("ControlOrMeta+K");
  await search.fill("新しいタスク");
  await search.press("Enter");
  const taskName = page.getByRole("textbox", { name: "タスクの名前" });
  await expect(taskName).toBeVisible();
  await taskName.press("Escape");
  await expect(taskName).toHaveCount(0);

  // 「スレッドを検索」は左ペインを開いて検索欄に移る
  await page.keyboard.press("ControlOrMeta+K");
  await search.fill("けんさく");
  await expect(palette.getByRole("status")).toContainText(
    "一致する操作はありません",
  );
  await search.fill("検索");
  await search.press("Enter");
  await expect(sidebar).toBeVisible();
  await expect(
    sidebar.getByRole("searchbox", { name: "スレッドを検索" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");

  // Wiki からも開け、候補のクリックでも実行できる。「新しいスレッド」は入力欄に移る
  await createTask(page, "パレット");
  await openWiki(page, "パレット");
  await page.keyboard.press("ControlOrMeta+K");
  await expect(palette).toBeVisible();
  await search.fill("スレッド");
  await palette.getByRole("option", { name: "新しいスレッド" }).click();
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/\/c\/.+/);
  await expect(mainInput).toBeFocused();
  await expect(taskItem(page, "パレット")).toContainText("新しいスレッド");
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

  // 入力欄で書いている途中でも効き、ヘッダーに開いているスレッドの名前が出る
  await newChat(page);
  await expect(page.getByRole("main").locator("header")).toContainText(
    "新しいスレッド",
  );
  const box = page.getByRole("textbox", { name: "メッセージ", exact: true });
  await box.fill("下書き");
  await box.press("ControlOrMeta+B");
  await expect(sidebar).toBeHidden();
  await expect(box).toHaveValue("下書き");
  await box.press("ControlOrMeta+B");
  await expect(sidebar).toBeVisible();
});

test("左サイドバーの幅をドラッグとキーボードで変え、開き直しや再読み込みでも保つ（#185）", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const sidebar = page.getByRole("complementary", { name: "サイドバー" });
  const main = page.locator("main");
  const handle = page.getByRole("separator", { name: "サイドバーの幅" });
  const widthOf = async (locator: Locator) =>
    Math.round((await locator.boundingBox())?.width ?? 0);

  // 保存していなければ既定の幅
  await expect.poll(() => widthOf(sidebar)).toBe(256);

  // ドラッグの間、サイドバーとメインパネルが追従する
  const box = await handle.boundingBox();
  if (box === null) throw new Error("ハンドルが見えない");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 4 });
  await expect.poll(() => widthOf(sidebar)).toBe(316);
  await expect.poll(() => widthOf(main)).toBe(1280 - 316);
  await page.mouse.move(x + 100, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => widthOf(sidebar)).toBe(356);
  await expect(handle).toHaveAttribute("aria-valuenow", "356");

  // キーボードでも変えられる
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "340");
  await expect.poll(() => widthOf(sidebar)).toBe(340);

  // 閉じて開き直しても、再読み込みしても戻る
  await page.keyboard.press("ControlOrMeta+B");
  await expect(sidebar).toBeHidden();
  await expect(handle).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+B");
  await expect.poll(() => widthOf(sidebar)).toBe(340);
  await page.reload();
  await expect(sidebar).toBeVisible();
  await expect.poll(() => widthOf(sidebar)).toBe(340);

  // 広げすぎてもメインパネルの幅は残し、画面を狭くしても収める
  await handle.focus();
  await page.keyboard.press("End");
  await expect.poll(() => widthOf(main)).toBe(360);
  await page.setViewportSize({ width: 800, height: 800 });
  await expect.poll(() => widthOf(main)).toBe(360);
  await expect.poll(() => widthOf(sidebar)).toBe(440);
  await page.keyboard.press("Home");
  await expect.poll(() => widthOf(sidebar)).toBe(232);
});

test("右側のペインの幅をドラッグとキーボードで変え、開き直しや再読み込みでも保つ（#209）", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await open(page);
  await createTask(page, "右ペインの幅");
  await openWiki(page, "右ペインの幅");
  await page.getByRole("button", { name: "新しいノート" }).click();
  await page
    .getByRole("textbox", { name: "ノートのタイトル" })
    .fill("幅の検証");
  await page
    .getByRole("textbox", { name: "本文（Markdown）" })
    .fill("右側のペインと並べる。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "幅の検証" })).toBeVisible();

  const ask = page.getByRole("button", { name: "このノートについて質問" });
  const side = page.getByRole("complementary", { name: "サイドチャット" });
  const handle = page.getByRole("separator", { name: "右側のペインの幅" });
  const widthOf = async (locator: Locator) =>
    Math.round((await locator.boundingBox())?.width ?? 0);
  const rightOf = async (locator: Locator) => {
    const box = await locator.boundingBox();
    return Math.round((box?.x ?? 0) + (box?.width ?? 0));
  };

  // 閉じている間はハンドルを出さない。保存していなければ既定の幅（並べる領域の 42%）
  await expect(handle).toHaveCount(0);
  await ask.click();
  await expect(side).toBeVisible();
  // 並べる領域 = 1600 - サイドバー 256 - ノートの一覧 240 = 1104
  await expect.poll(() => widthOf(side)).toBe(Math.round(1104 * 0.42));
  await expect(handle).toHaveAttribute("aria-valuemax", String(1104 - 360));

  // 左へドラッグすると広がり、右端は画面の端のまま
  const box = await handle.boundingBox();
  if (box === null) throw new Error("ハンドルが見えない");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 60, y, { steps: 4 });
  await expect.poll(() => widthOf(side)).toBe(464 + 60);
  await page.mouse.move(x - 100, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => widthOf(side)).toBe(564);
  await expect.poll(() => rightOf(side)).toBe(1600);
  await expect(handle).toHaveAttribute("aria-valuenow", "564");

  // キーボードでは → で狭まる
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "548");
  await expect.poll(() => widthOf(side)).toBe(548);

  // 閉じて開き直しても、再読み込みしても戻る
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();
  await expect(handle).toHaveCount(0);
  await ask.click();
  await expect.poll(() => widthOf(side)).toBe(548);
  await page.reload();
  await ask.click();
  await expect.poll(() => widthOf(side)).toBe(548);

  // 左サイドバーを広げきっても、ノートの本文と右側のペインの幅を残す
  const sidebarHandle = page.getByRole("separator", {
    name: "サイドバーの幅",
  });
  await sidebarHandle.focus();
  await page.keyboard.press("End");
  await expect(sidebarHandle).toHaveAttribute(
    "aria-valuenow",
    String(1600 - 360 - 240 - 320),
  );
  await expect.poll(() => widthOf(side)).toBe(320);
  // 右側のペインを閉じると、サイドバーはまた広げられる
  await side.getByRole("button", { name: "サイドチャットを閉じる" }).click();
  await expect(sidebarHandle).toHaveAttribute(
    "aria-valuemax",
    String(1600 - 360),
  );
  await sidebarHandle.focus();
  await page.keyboard.press("Home");

  // 狭い画面では右側のペインを単独で、画面幅に合わせて表示する（ハンドルは出さない）
  await page.setViewportSize({ width: 800, height: 900 });
  await ask.click();
  await expect(side).toBeVisible();
  await expect(handle).toBeHidden();
});

test("macOS では Ctrl+B を入力欄に渡し、⌘B でサイドバーを開閉する", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
  });
  await open(page);
  await newChat(page);
  const sidebar = page.getByRole("complementary", { name: "サイドバー" });
  const box = page.getByRole("textbox", { name: "メッセージ", exact: true });
  await box.focus();
  const defaultAllowed = await box.evaluate((input) =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "b",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(defaultAllowed).toBe(true);
  await expect(sidebar).toBeVisible();

  await box.press("Meta+B");
  await expect(sidebar).toBeHidden();
});
