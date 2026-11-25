import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

export class DirectoryPickerUnavailableError extends ErrorFactory({
  name: "DirectoryPickerUnavailableError",
  message:
    "この環境ではフォルダを選ぶダイアログを開けません。パスを入力してください。",
}) {}

export class DirectoryPickerError extends ErrorFactory({
  name: "DirectoryPickerError",
  message: "フォルダを選ぶダイアログを開けませんでした。",
}) {}

/** 選んだディレクトリの絶対パス。キャンセルしたら null。 */
export type DirectoryPicker = () => Promise<
  Result.Result<
    string | null,
    DirectoryPickerUnavailableError | DirectoryPickerError
  >
>;

/** コマンドを実行した結果。 */
export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type RunCommand = (command: string[]) => Promise<CommandResult>;

const PROMPT = "環境に追加するディレクトリを選んでください";

const runWithBun: RunCommand = async (command) => {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/** プラットフォームごとの、フォルダを選ぶダイアログのコマンド。 */
const commandFor = (
  platform: NodeJS.Platform,
  which: (command: string) => string | null,
): string[] | undefined => {
  if (platform === "darwin") {
    return [
      "osascript",
      "-e",
      `POSIX path of (choose folder with prompt "${PROMPT}")`,
    ];
  }
  if (platform === "linux" && which("zenity") !== null) {
    return ["zenity", "--file-selection", "--directory", `--title=${PROMPT}`];
  }
  return undefined;
};

/**
 * このマシンの OS のフォルダを選ぶダイアログを開く（サーバとブラウザが同じマシンで動く前提）。
 * macOS は osascript、Linux は zenity を使う。
 */
export const createDirectoryPicker = (
  options: {
    platform?: NodeJS.Platform;
    which?: (command: string) => string | null;
    run?: RunCommand;
  } = {},
): DirectoryPicker => {
  const command = commandFor(
    options.platform ?? process.platform,
    options.which ?? ((name) => Bun.which(name)),
  );
  const run = options.run ?? runWithBun;
  return async () => {
    if (command === undefined) {
      return Result.fail(new DirectoryPickerUnavailableError());
    }
    const result = await Result.try({
      try: () => run(command),
      catch: (cause) => new DirectoryPickerError({ cause }),
    });
    if (Result.isFailure(result)) return result;
    const { exitCode, stdout, stderr } = result.value;
    if (exitCode === 0) {
      const path = stdout.trim();
      return Result.succeed(path === "" ? null : path);
    }
    // キャンセル（osascript は -128、zenity は終了コード 1 で何も出さない）
    if (stderr.includes("-128") || (exitCode === 1 && stderr.trim() === "")) {
      return Result.succeed(null);
    }
    return Result.fail(new DirectoryPickerError({ cause: stderr }));
  };
};
