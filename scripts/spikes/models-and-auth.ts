#!/usr/bin/env bun
/**
 * Spike #16: プロンプトを送らずに、モデル一覧・アカウント情報・ログイン状態を取得できるか確認する。
 * メールアドレスや組織名は表示しない。
 *
 *   bun scripts/spikes/models-and-auth.ts [path-to-claude]
 */
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** 何も送らずに待ち続ける入力。close() で終わらせる。 */
const idleInput = () => {
  let close: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const iterable: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      await closed;
    },
  };
  return { iterable, close };
};

const main = async () => {
  const claudePath = process.argv[2] ?? Bun.which("claude");
  if (claudePath === null || claudePath === undefined) {
    throw new Error("claude が見つかりません");
  }
  const input = idleInput();
  const started = Date.now();
  const q = query({
    prompt: input.iterable,
    options: {
      pathToClaudeCodeExecutable: claudePath,
      settingSources: [],
      tools: [],
    },
  });
  try {
    const [models, account, init] = await Promise.all([
      q.supportedModels(),
      q.accountInfo(),
      q.initializationResult(),
    ]);
    console.log(`elapsed: ${Date.now() - started}ms`);
    console.log("## supportedModels");
    for (const m of models) {
      console.log(
        `- ${m.value} (${m.displayName}) resolved=${m.resolvedModel ?? "-"} effort=${m.supportsEffort ? (m.supportedEffortLevels ?? []).join("/") : "no"} adaptiveThinking=${m.supportsAdaptiveThinking ?? false}`,
      );
    }
    console.log("## accountInfo（識別情報は伏せる）");
    console.log({
      hasEmail: account.email !== undefined,
      hasOrganization: account.organization !== undefined,
      subscriptionType: account.subscriptionType,
      tokenSource: account.tokenSource,
      apiKeySource: account.apiKeySource,
      apiProvider: account.apiProvider,
    });
    console.log("## initializationResult のキー");
    console.log(Object.keys(init));
  } catch (error) {
    console.log(`elapsed: ${Date.now() - started}ms`);
    console.log("error:", error instanceof Error ? error.message : error);
  } finally {
    input.close();
    q.return(undefined);
  }
};

await main();
