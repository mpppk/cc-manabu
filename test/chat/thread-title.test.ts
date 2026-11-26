import { beforeEach, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import {
  buildThreadTitlePrompt,
  createWikiThreadTitler,
  parseThreadTitle,
} from "../../src/chat/thread-title.ts";
import {
  type ChatRepository,
  createChatRepository,
} from "../../src/db/chat-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import { createTaskRepository } from "../../src/db/task-repository.ts";

const unwrap = <T>(result: Result.Result<T, unknown>): T => {
  if (Result.isFailure(result)) throw result.error;
  return result.value;
};

let chats: ChatRepository;
let taskId: string;

beforeEach(() => {
  const { db } = unwrap(openDatabase(":memory:"));
  chats = createChatRepository(db);
  taskId = unwrap(createTaskRepository(db).createTask({ name: "t" })).id;
});

const wikiChat = (title = "個人情報の取扱い") =>
  unwrap(
    chats.getOrCreateWikiChat({
      id: crypto.randomUUID(),
      taskId,
      wikiPageId: "page-1",
      title,
      cwd: "/work",
    }),
  );

const titleOf = (chatId: string) => unwrap(chats.getChat(chatId)).chat.title;

const finished = (chatId: string, question = "委託先に渡すと第三者提供？") => ({
  chatId,
  messageId: crypto.randomUUID(),
  question,
  answer: "委託は第三者提供にあたらない。",
});

test("プロンプトにページ名・質問・回答を入れる", () => {
  const prompt = buildThreadTitlePrompt({
    pageTitle: "個人情報の取扱い",
    question: "委託先に渡すと第三者提供？",
    answer: "あたらない。",
  });
  expect(prompt).toContain("<page-title>\n個人情報の取扱い\n</page-title>");
  expect(prompt).toContain(
    "<question>\n委託先に渡すと第三者提供？\n</question>",
  );
  expect(prompt).toContain("<answer>\nあたらない。\n</answer>");
});

test("出力から 1 行のタイトルを取り出す", () => {
  expect(parseThreadTitle("「委託先への提供と第三者提供の違い」")).toBe(
    "委託先への提供と第三者提供の違い",
  );
  expect(parseThreadTitle("タイトル: **委託と第三者提供**。\n補足")).toBe(
    "委託と第三者提供",
  );
  expect(parseThreadTitle("  \n")).toBeUndefined();
  expect([...(parseThreadTitle("あ".repeat(100)) ?? "")]).toHaveLength(40);
});

test("最初の回答のあとに一度だけタイトルを付ける", async () => {
  const prompts: string[] = [];
  const titler = createWikiThreadTitler({
    chats,
    generate: async (prompt) => {
      prompts.push(prompt);
      return "委託先への提供と第三者提供の違い";
    },
  });
  const chat = wikiChat();
  titler.track(chat);
  expect(await titler.onAnswerFinish(finished(chat.id))).toBe(
    "委託先への提供と第三者提供の違い",
  );
  expect(titleOf(chat.id)).toBe("委託先への提供と第三者提供の違い");
  expect(prompts[0]).toContain("個人情報の取扱い");

  // 追加の質問では作り直さない
  expect(
    await titler.onAnswerFinish(finished(chat.id, "それはなぜ？")),
  ).toBeUndefined();
  expect(prompts).toHaveLength(1);
});

test("覚えていない会話（既存のスレッド・通常の会話）には付けない", async () => {
  let called = false;
  const titler = createWikiThreadTitler({
    chats,
    generate: async () => {
      called = true;
      return "x";
    },
  });
  const chat = wikiChat();
  expect(await titler.onAnswerFinish(finished(chat.id))).toBeUndefined();
  expect(called).toBe(false);
  expect(titleOf(chat.id)).toBe("個人情報の取扱い");
});

test("生成中に利用者が名前を変えたら、変えた名前を残す", async () => {
  const chat = wikiChat();
  const titler = createWikiThreadTitler({
    chats,
    generate: async () => {
      unwrap(chats.setGroupTitle(chat.groupId, "手で付けた名前"));
      return "生成したタイトル";
    },
  });
  titler.track(chat);
  expect(await titler.onAnswerFinish(finished(chat.id))).toBeUndefined();
  expect(titleOf(chat.id)).toBe("手で付けた名前");
});

test("生成に失敗したらページ名のまま残す", async () => {
  const errors: unknown[] = [];
  const titler = createWikiThreadTitler({
    chats,
    generate: async () => {
      throw new Error("boom");
    },
    onError: (error) => errors.push(error),
  });
  const chat = wikiChat();
  titler.track(chat);
  expect(await titler.onAnswerFinish(finished(chat.id))).toBeUndefined();
  expect(errors).toHaveLength(1);
  expect(titleOf(chat.id)).toBe("個人情報の取扱い");
});
