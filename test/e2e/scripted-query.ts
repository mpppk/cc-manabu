import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { QueryFunction } from "../../src/provider/types.ts";

/**
 * E2E 用のモック query()。プロンプトの内容で振る舞いを変える（台本）。
 *
 * - 「Wiki に書く: <タイトル>|<本文>」を含む: Wiki の MCP ツール（承認なしで直接呼ぶ）で、
 *   同じタイトルのページがあれば update_page、無ければ create_page で書き、ツールの呼び出しとして流す
 * - 「承認」を含む: Bash の承認を求め、許可なら「許可されました」、拒否なら「拒否されました」と返す
 * - 「ゆっくり」を含む: 1〜40 を 1 行ずつ、150ms 間隔で流す（リロード・停止の確認用）
 * - 用語抽出（<term-extraction>）: 回答の中の「」で囲まれた語を用語として JSON で返す
 * - 回答の要約（<answer-summary>）: 「要約（<回答の文字数> 文字の回答）」と返す
 * - Wiki ページの Q&A（<wiki-page-qa>）: 質問を「Q: <質問>」（前のやり取りがあれば
 *   「（<最初の質問> について）」を補う）、回答を「<回答の文字数> 文字の回答の要約」にした JSON を返す。
 *   質問に「Q&A失敗」を含むと JSON でない文字列を返す（作成の失敗）
 * - スレッドのタイトル（<thread-title>）: 1 秒待ってから「<質問> の論点」と返す。
 *   質問に「タイトル失敗」を含むと空を返す（生成の失敗）
 * - 選択範囲からのページ生成（<wiki-page-generation>）: 1 秒待ってから「<語句> は…」の本文を返す。
 *   語句に「失敗」を含むと空の本文を返す（生成の失敗）
 * - Wiki の参照資料付き: 「参照: [タイトル](wiki:ID)…」と、渡していないページへの偽の引用を返す
 * - 画像付き: 「画像 <枚数> 枚: <テキスト>」と返す
 * - それ以外: 「了解: <プロンプト>」と返す
 *
 * resume / fork を受け取ったセッション ID はそのまま（fork なら新しい ID を）返す。
 */
export const createScriptedQuery = (): QueryFunction => {
  let counter = 0;
  return ({ prompt, options }) => {
    const sessionId =
      options?.resume !== undefined && options.forkSession !== true
        ? options.resume
        : `session-${++counter}`;
    const signal = options?.abortController?.signal;
    const base = { session_id: sessionId, parent_tool_use_id: null };
    let block = 0;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });

    async function* textMessage(
      chunks: string[],
      delayMs: number,
    ): AsyncGenerator<SDKMessage> {
      const index = block++;
      yield {
        ...base,
        type: "stream_event",
        uuid: crypto.randomUUID(),
        // 実機の Claude サブスクリプションと同じく、1 時間の TTL でキャッシュに書き込む
        event: {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 100,
              cache_creation: {
                ephemeral_5m_input_tokens: 0,
                ephemeral_1h_input_tokens: 100,
              },
            },
          },
        },
      } as unknown as SDKMessage;
      yield {
        ...base,
        type: "stream_event",
        uuid: crypto.randomUUID(),
        event: {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
      } as unknown as SDKMessage;
      for (const chunk of chunks) {
        if (signal?.aborted) return;
        yield {
          ...base,
          type: "stream_event",
          uuid: crypto.randomUUID(),
          event: {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: chunk },
          },
        } as unknown as SDKMessage;
        if (delayMs > 0) await sleep(delayMs);
      }
      yield {
        ...base,
        type: "assistant",
        uuid: crypto.randomUUID(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: chunks.join("") }],
        },
      } as unknown as SDKMessage;
      yield {
        ...base,
        type: "stream_event",
        uuid: crypto.randomUUID(),
        event: { type: "content_block_stop", index },
      } as unknown as SDKMessage;
    }

    /** in-process の Wiki の MCP サーバのツールを呼ぶ（承認は通さない）。 */
    const callWikiTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ content: { type: string; text: string }[] } | undefined> => {
      const server = options?.mcpServers?.wiki as
        | {
            instance?: {
              _registeredTools: Record<
                string,
                { handler: (args: unknown, extra: unknown) => unknown }
              >;
            };
          }
        | undefined;
      const tool = server?.instance?._registeredTools[name];
      return tool === undefined
        ? undefined
        : ((await tool.handler(args, {})) as {
            content: { type: string; text: string }[];
          });
    };

    async function* wikiToolCall(
      name: string,
      args: Record<string, unknown>,
    ): AsyncGenerator<SDKMessage> {
      const id = `toolu_${crypto.randomUUID()}`;
      yield {
        ...base,
        type: "assistant",
        uuid: crypto.randomUUID(),
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id, name: `mcp__wiki__${name}`, input: args },
          ],
        },
      } as unknown as SDKMessage;
      const result = await callWikiTool(name, args);
      yield {
        ...base,
        type: "user",
        uuid: crypto.randomUUID(),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              content: result?.content ?? [{ type: "text", text: "no tool" }],
            },
          ],
        },
      } as unknown as SDKMessage;
    }

    return (async function* (): AsyncGenerator<SDKMessage> {
      // 画像付きの発話は、content ブロックを持つユーザーメッセージで届く
      let text = typeof prompt === "string" ? prompt : "";
      let images = 0;
      let reference = "";
      /** タスクと環境の参照情報（#186）。 */
      let taskContext = "";
      if (typeof prompt !== "string") {
        for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
          const { content } = message.message;
          for (const item of typeof content === "string" ? [] : content) {
            if (item.type === "image") images++;
            if (item.type === "text") {
              if (item.text.includes("<task-context>")) {
                taskContext +=
                  /<task-context>\n([\s\S]*?)\n<\/task-context>/.exec(
                    item.text,
                  )?.[1] ?? "";
              }
              if (item.text.includes("<wiki-page")) reference += item.text;
              else if (!item.text.includes("<task-context>")) text += item.text;
            }
          }
        }
      }
      const cited = [
        ...reference.matchAll(/<wiki-page id="([^"]+)" title="([^"]+)"/g),
      ].map(([, id, title]) => `[${title}](wiki:${id})`);

      yield {
        ...base,
        type: "system",
        subtype: "init",
        model: "mock",
        uuid: crypto.randomUUID(),
      } as unknown as SDKMessage;

      const wikiWrite = /Wiki に書く: ([^|\n]+)\|([^\n]+)/.exec(text);
      if (wikiWrite !== null && !text.includes("<")) {
        const [, title = "", body = ""] = wikiWrite;
        const listed = await callWikiTool("list_pages", {});
        const existing = new RegExp(
          `- ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}（id: ([^、）]+)`,
        ).exec(listed?.content[0]?.text ?? "")?.[1];
        yield* existing === undefined
          ? wikiToolCall("create_page", { title, body })
          : wikiToolCall("update_page", { id: existing, body });
        yield* textMessage([`Wiki の「${title}」に書きました。`], 0);
      } else if (text.includes("<term-extraction>")) {
        const answer = /<answer>\n([\s\S]*?)\n<\/answer>/.exec(text)?.[1] ?? "";
        const terms = [...answer.matchAll(/「([^」]{2,20})」/g)].map(
          ([, term]) => ({ term, aliases: [], summary: `${term} の説明。` }),
        );
        yield* textMessage([JSON.stringify(terms)], 0);
      } else if (text.includes("<wiki-page-generation>")) {
        const term = /<term>\n([\s\S]*?)\n<\/term>/.exec(text)?.[1] ?? "";
        // 生成中の表示を確かめられるように、少し待つ
        await sleep(1000);
        yield* textMessage(
          [
            term.includes("失敗")
              ? ""
              : `${term} は回答に出てきた語。\n\n## 補足\n\n生成したページ。`,
          ],
          0,
        );
      } else if (text.includes("<wiki-page-qa>")) {
        const question =
          /<question>\n([\s\S]*?)\n<\/question>/.exec(text)?.[1] ?? "";
        const answer = /<answer>\n([\s\S]*?)\n<\/answer>/.exec(text)?.[1] ?? "";
        const previous = /<turn>\n質問: ([^\n]*)/.exec(text)?.[1];
        yield* textMessage(
          [
            question.includes("Q&A失敗")
              ? "作れませんでした"
              : JSON.stringify({
                  question: `Q: ${question}${previous === undefined ? "" : `（${previous} について）`}`,
                  answer: `${[...answer].length} 文字の回答の要約`,
                }),
          ],
          0,
        );
      } else if (text.includes("<thread-title>")) {
        const question =
          /<question>\n([\s\S]*?)\n<\/question>/.exec(text)?.[1] ?? "";
        // 仮のタイトルを確かめられるように、少し待つ
        await sleep(1000);
        yield* textMessage(
          [question.includes("タイトル失敗") ? "" : `${question} の論点`],
          0,
        );
      } else if (text.includes("<answer-summary>")) {
        const answer = /<answer>\n([\s\S]*?)\n<\/answer>/.exec(text)?.[1] ?? "";
        // 回答の文言を繰り返すと、画面上で回答の本文と区別できなくなるので文字数だけ使う
        yield* textMessage([`要約（${[...answer].length} 文字の回答）`], 0);
      } else if (text.includes("タスクの情報を教えて")) {
        yield* textMessage(
          [taskContext === "" ? "タスクの情報はありません" : taskContext],
          0,
        );
      } else if (text.includes("承認")) {
        const decision = await options?.canUseTool?.(
          "Bash",
          { command: "touch e2e.txt", description: "Create e2e.txt" },
          {
            signal: signal ?? new AbortController().signal,
            suggestions: [],
            toolUseID: "toolu_e2e",
            displayName: "Bash",
            description: "Create e2e.txt",
          } as never,
        );
        yield* textMessage(
          [
            decision?.behavior === "allow"
              ? "許可されました"
              : "拒否されました",
          ],
          0,
        );
      } else if (text.includes("ゆっくり")) {
        yield* textMessage(
          Array.from({ length: 40 }, (_, i) => `${i + 1}\n`),
          150,
        );
      } else if (cited.length > 0) {
        yield* textMessage(
          [`参照: ${cited.join(" ")} と [偽のページ](wiki:fake)。`, text],
          0,
        );
      } else if (images > 0) {
        yield* textMessage([`画像 ${images} 枚: `, text], 0);
      } else {
        yield* textMessage(["了解: ", text], 0);
      }

      if (signal?.aborted) return;
      // 実機と同じく、回答のたびに利用枠の情報が届く（docs/spikes/rate-limits.md）
      const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
      yield {
        ...base,
        type: "rate_limit_event",
        uuid: crypto.randomUUID(),
        rate_limit_info: {
          status: "allowed",
          resetsAt,
          rateLimitType: "five_hour",
          unifiedWindows: {
            five_hour: { utilization: 0.62, resetsAt, status: "allowed" },
            seven_day: {
              utilization: 0.67,
              resetsAt: resetsAt + 3 * 24 * 60 * 60,
              status: "allowed",
            },
          },
        },
      } as unknown as SDKMessage;
      yield {
        ...base,
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        is_error: false,
        result: "",
        duration_ms: 10,
        duration_api_ms: 10,
        num_turns: 1,
        total_cost_usd: 0.001,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        permission_denials: [],
        uuid: crypto.randomUUID(),
      } as unknown as SDKMessage;
    })();
  };
};
