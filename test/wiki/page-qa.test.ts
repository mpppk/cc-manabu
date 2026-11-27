import { beforeEach, expect, test } from "bun:test";
import { Result } from "@praha/byethrow";
import {
  type ChatRepository,
  createChatRepository,
} from "../../src/db/chat-repository.ts";
import { openDatabase } from "../../src/db/index.ts";
import {
  createTaskRepository,
  requireWikiId,
} from "../../src/db/task-repository.ts";
import {
  createWikiRepository,
  type WikiRepository,
} from "../../src/db/wiki-repository.ts";
import {
  buildPageQaPrompt,
  createPageQaWriter,
  parsePageQa,
  previousTurns,
} from "../../src/wiki/page-qa.ts";

const unwrap = <T>(result: Result.Result<T, unknown>): T => {
  if (Result.isFailure(result)) throw result.error;
  return result.value;
};

/** 環境の Wiki（テストのタスクは Wiki のある環境に作る）。 */
const wikiIdOf = (task: Parameters<typeof requireWikiId>[0]): string =>
  unwrap(requireWikiId(task));

let chats: ChatRepository;
let wiki: WikiRepository;
let taskId: string;
let pageId: string;

beforeEach(() => {
  const { db } = unwrap(openDatabase(":memory:"));
  chats = createChatRepository(db);
  wiki = createWikiRepository(db);
  const task = unwrap(createTaskRepository(db).createTask({ name: "t" }));
  taskId = task.id;
  pageId = unwrap(
    wiki.createPage({
      wikiId: wikiIdOf(task),
      title: "個人情報の取扱い",
      aliases: [],
      body: "本文",
    }),
  ).id;
});

const text = (value: string) => [{ type: "text", text: value }];

/** Wiki ページの会話に、質問と回答のやり取りを保存する。最後の回答の id を返す。 */
const converse = (chatId: string, turns: [string, string][]) => {
  let answerId = "";
  for (const [question, answer] of turns) {
    unwrap(
      chats.saveMessage(chatId, {
        id: crypto.randomUUID(),
        role: "user",
        parts: text(question),
      }),
    );
    answerId = crypto.randomUUID();
    unwrap(
      chats.saveMessage(chatId, {
        id: answerId,
        role: "assistant",
        parts: text(answer),
      }),
    );
  }
  return answerId;
};

const wikiChat = () =>
  unwrap(
    chats.getOrCreateWikiChat({
      id: crypto.randomUUID(),
      taskId,
      wikiPageId: pageId,
      title: "個人情報の取扱い",
      cwd: "/work",
    }),
  );

test("出力の JSON から Q&A を取り出し、形が合わなければ捨てる", () => {
  expect(
    parsePageQa(
      '```json\n{"question": " 委託は？ ", "answer": "あたらない"}\n```',
    ),
  ).toEqual({ question: "委託は？", answer: "あたらない" });
  expect(parsePageQa("作れませんでした")).toBeUndefined();
  expect(parsePageQa('{"question": "", "answer": "x"}')).toBeUndefined();
  expect(parsePageQa('{"question": "q"}')).toBeUndefined();
});

test("今回の回答より前のやり取りを文脈にする", () => {
  const messages = [
    { id: "u1", role: "user", parts: text("委託先に渡すと第三者提供？") },
    { id: "a1", role: "assistant", parts: text("あたらない。") },
    { id: "u2", role: "user", parts: text("それはなぜ？") },
    { id: "a2", role: "assistant", parts: text("委託は本人の代わりだから。") },
  ];
  expect(previousTurns(messages, "a2")).toEqual([
    { question: "委託先に渡すと第三者提供？", answer: "あたらない。" },
  ]);
  expect(previousTurns(messages, "a1")).toEqual([]);
  const prompt = buildPageQaPrompt({
    pageTitle: "個人情報の取扱い",
    previous: previousTurns(messages, "a2"),
    question: "それはなぜ？",
    answer: "委託は本人の代わりだから。",
  });
  expect(prompt).toContain("質問: 委託先に渡すと第三者提供？");
  expect(prompt).toContain("<question>\nそれはなぜ？\n</question>");
});

test("Wiki ページの会話の回答から Q&A を作り、同じ回答では重ねて作らない", async () => {
  const prompts: string[] = [];
  const write = createPageQaWriter({
    chats,
    wiki,
    generate: async (prompt) => {
      prompts.push(prompt);
      return '{"question": "委託先への提供は第三者提供にあたる？", "answer": "あたらない。"}';
    },
  });
  const chat = wikiChat();
  const messageId = converse(chat.id, [["委託は？", "あたらない。"]]);
  const event = {
    chatId: chat.id,
    messageId,
    question: "委託は？",
    answer: "あたらない。",
  };
  expect(await write(event)).toMatchObject({
    taskId,
    wikiPageId: pageId,
    chatId: chat.id,
    messageId,
    question: "委託先への提供は第三者提供にあたる？",
  });
  expect(prompts[0]).toContain("個人情報の取扱い");
  expect(await write(event)).toBeUndefined();
  expect(unwrap(wiki.listQas(taskId, pageId))).toHaveLength(1);
});

test("Wiki ページの会話でなければ作らない（モデルも呼ばない）", async () => {
  let called = false;
  const write = createPageQaWriter({
    chats,
    wiki,
    generate: async () => {
      called = true;
      return '{"question": "q", "answer": "a"}';
    },
  });
  const chat = unwrap(chats.createChat({ cwd: "/work", taskId }));
  const messageId = converse(chat.id, [["q", "a"]]);
  expect(
    await write({ chatId: chat.id, messageId, question: "q", answer: "a" }),
  ).toBeUndefined();
  expect(called).toBe(false);
});

test("作成に失敗しても例外を投げず、何も保存しない", async () => {
  const errors: unknown[] = [];
  const write = createPageQaWriter({
    chats,
    wiki,
    generate: async () => {
      throw new Error("boom");
    },
    onError: (error) => errors.push(error),
  });
  const chat = wikiChat();
  const messageId = converse(chat.id, [["q", "a"]]);
  expect(
    await write({ chatId: chat.id, messageId, question: "q", answer: "a" }),
  ).toBeUndefined();
  expect(errors).toHaveLength(1);
  expect(unwrap(wiki.listQas(taskId, pageId))).toEqual([]);
});
