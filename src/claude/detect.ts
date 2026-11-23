import type {
  AccountInfo,
  ModelInfo,
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

export class ClaudeNotInstalledError extends ErrorFactory({
  name: "ClaudeNotInstalledError",
  message: (fields) =>
    fields.configuredPath === undefined
      ? "Claude Code (the claude command) was not found in PATH."
      : `Claude Code was not found at CC_MANABU_CLAUDE_PATH=${fields.configuredPath}.`,
  fields: ErrorFactory.fields<{ configuredPath: string | undefined }>(),
}) {}

export class ClaudeProbeError extends ErrorFactory({
  name: "ClaudeProbeError",
  message: "Failed to get information from Claude Code",
}) {}

/** `claude` の実行ファイルを探す。CC_MANABU_CLAUDE_PATH → PATH の順。 */
export const resolveClaudePath = (deps: {
  env: Record<string, string | undefined>;
  which: (command: string) => string | null;
  exists: (path: string) => boolean;
}): Result.Result<string, ClaudeNotInstalledError> => {
  const configured = deps.env.CC_MANABU_CLAUDE_PATH;
  if (configured !== undefined && configured !== "") {
    return deps.exists(configured)
      ? Result.succeed(configured)
      : Result.fail(
          new ClaudeNotInstalledError({ configuredPath: configured }),
        );
  }
  const found = deps.which("claude");
  return found === null
    ? Result.fail(new ClaudeNotInstalledError({ configuredPath: undefined }))
    : Result.succeed(found);
};

/** `claude --version` の出力（例: "2.1.330 (Claude Code)"）からバージョンを取り出す。 */
export const parseClaudeVersion = (output: string): string | undefined =>
  /(\d+\.\d+\.\d+)/.exec(output)?.[1];

export const getClaudeVersion = async (
  claudePath: string,
): Promise<string | undefined> => {
  const proc = Bun.spawn([claudePath, "--version"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return parseClaudeVersion(output);
};

/** UI に返すアカウント情報。メールアドレスと組織名は含めない。 */
export type AccountSummary = Pick<
  AccountInfo,
  "subscriptionType" | "tokenSource" | "apiKeySource" | "apiProvider"
>;

export type ClaudeProbe = {
  models: ModelInfo[];
  account: AccountSummary;
};

type ProbeQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Pick<Query, "supportedModels" | "accountInfo" | "return">;

/**
 * プロンプトを送らずに Claude Code を起動し、モデル一覧とアカウント情報を取る（docs/spikes/models-and-auth.md）。
 */
export const probeClaude = (
  claudePath: string,
  options: { query?: ProbeQuery; timeoutMs?: number } = {},
): Result.ResultAsync<ClaudeProbe, ClaudeProbeError> => {
  const query: ProbeQuery = options.query ?? sdkQuery;
  let release: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const idleInput: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        await closed;
        return { done: true, value: undefined };
      },
    }),
  };

  return Result.try({
    try: async () => {
      const q = query({
        prompt: idleInput,
        options: {
          pathToClaudeCodeExecutable: claudePath,
          settingSources: [],
          tools: [],
        },
      });
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out")),
            options.timeoutMs ?? 15_000,
          ),
        );
        const [models, account] = await Promise.race([
          Promise.all([q.supportedModels(), q.accountInfo()]),
          timeout,
        ]);
        return {
          models,
          account: {
            subscriptionType: account.subscriptionType,
            tokenSource: account.tokenSource,
            apiKeySource: account.apiKeySource,
            apiProvider: account.apiProvider,
          },
        };
      } finally {
        release();
        await q.return(undefined);
      }
    },
    catch: (cause) => new ClaudeProbeError({ cause }),
  });
};
