import { ErrorFactory } from "@praha/error-factory";

/** CLI を指定した終了コードで終えるためのエラー。メッセージは表示しない。 */
export class CliExit extends ErrorFactory({
  name: "CliExit",
  message: (fields) => `Exit with code ${fields.code}`,
  fields: ErrorFactory.fields<{ code: number }>(),
}) {}

/** CLI の最外層で使うエラーハンドラ。 */
export const handleCliError = (
  error: unknown,
  io: {
    exit: (code: number) => never;
    printError: (message: string) => void;
  } = {
    exit: (code) => process.exit(code),
    printError: (message) => console.error(message),
  },
): never => {
  if (error instanceof CliExit) {
    return io.exit(error.code);
  }
  io.printError(error instanceof Error ? error.message : String(error));
  return io.exit(1);
};
