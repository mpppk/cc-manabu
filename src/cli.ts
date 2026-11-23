import { parseArgs } from "node:util";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import { CliExit } from "./errors/index.ts";
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

export class NotImplementedError extends ErrorFactory({
  name: "NotImplementedError",
  message: (fields) => `${fields.feature} is not implemented yet`,
  fields: ErrorFactory.fields<{ feature: string }>(),
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
`;

type CliIo = {
  print: (message: string) => void;
};

const defaultIo: CliIo = { print: (message) => console.log(message) };

/** CLI のコマンドを実行する。失敗は Result で返す。 */
export const runCli = async (
  argv: readonly string[],
  commandName: string,
  io: CliIo = defaultIo,
): Result.ResultAsync<
  void,
  UnknownCommandError | InvalidArgumentsError | NotImplementedError
> => {
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
      // 自己アップデートは #45 で実装する。
      return Result.fail(new NotImplementedError({ feature: "update" }));
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
