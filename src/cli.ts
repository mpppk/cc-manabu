import { parseArgs } from "node:util";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { CliExit } from "./errors/index.ts";
import { type UpdateError, type UpdateOutcome, update } from "./update.ts";
import { name, version } from "./version.ts";

export class UnknownCommandError extends ErrorFactory({
  name: "UnknownCommandError",
  message: (fields) =>
    `Unknown command: ${fields.command}\nRun '${fields.commandName} --help' for usage.`,
  fields: ErrorFactory.fields<{ command: string; commandName: string }>(),
}) {}

export class InvalidArgumentsError extends ErrorFactory({
  name: "InvalidArgumentsError",
  message: (fields) => fields.detail,
  fields: ErrorFactory.fields<{ detail: string }>(),
}) {}

export const helpText = (commandName: string): string =>
  `${name} ${version}
Claude Code のログインを使って、ブラウザから Claude と会話するローカルチャットアプリ

使い方:
  ${commandName}              ローカルサーバを起動してブラウザを開く
  ${commandName} update       最新版に更新する
  ${commandName} --help, -h   このヘルプを表示する
  ${commandName} --version, -v
                              バージョンを表示する

環境変数:
  CC_MANABU_PORT              待ち受けるポート（既定: 空いているポート）
  CC_MANABU_NO_OPEN=1         起動時にブラウザを開かない
  CC_MANABU_NO_AUTH=1         アクセストークンを要求しない（デバッグ用。
                              同じマシンの他のプロセスからも API を呼べる）
`;

type CliIo = {
  print: (message: string) => void;
  /** update コマンドの本体（テストで差し替える）。 */
  update: (
    log: (message: string) => void,
  ) => Result.ResultAsync<UpdateOutcome, UpdateError>;
};

const defaultIo: CliIo = {
  print: (message) => console.log(message),
  update: (log) =>
    update({
      currentVersion: version,
      execPath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      fetch: (url) => fetch(url),
      log,
    }),
};

/** CLI のコマンドを実行する。失敗は Result で返す。 */
export const runCli = async (
  argv: readonly string[],
  commandName: string,
  overrides: Partial<CliIo> = {},
): Result.ResultAsync<
  void,
  UnknownCommandError | InvalidArgumentsError | UpdateError
> => {
  const io: CliIo = { ...defaultIo, ...overrides };
  const [command, ...rest] = argv;

  switch (command) {
    case "--version":
    case "-v":
      io.print(version);
      return Result.succeed();
    case undefined:
    case "--help":
    case "-h":
    case "help":
      io.print(helpText(commandName));
      return Result.succeed();
    case "update": {
      const parsed = Result.try({
        try: () =>
          parseArgs({
            args: [...rest],
            options: {},
            strict: true,
            allowPositionals: false,
          }),
        catch: (error) =>
          new InvalidArgumentsError({
            detail: error instanceof Error ? error.message : String(error),
            cause: error,
          }),
      });
      if (Result.isFailure(parsed)) {
        return parsed;
      }
      const outcome = await io.update(io.print);
      if (Result.isFailure(outcome)) {
        return outcome;
      }
      io.print(
        outcome.value.kind === "updated"
          ? `v${outcome.value.to} に更新しました。`
          : `最新版（v${outcome.value.version}）です。`,
      );
      return Result.succeed();
    }
    default:
      return Result.fail(new UnknownCommandError({ command, commandName }));
  }
};

/** CLI のエントリ。失敗したら例外にして最外層の handleCliError に渡す。 */
export const runCliOrThrow = async (
  argv: readonly string[],
  commandName: string,
): Promise<void> => {
  const result = await runCli(argv, commandName);
  if (Result.isFailure(result)) {
    console.error(result.error.message);
    throw new CliExit({ code: 1 });
  }
};
