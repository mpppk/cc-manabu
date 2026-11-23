import { describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";
import {
  CliExit,
  handleCliError,
  toError,
  toOrpcError,
  UnexpectedError,
  unwrapForOrpc,
} from "../../src/errors/index.ts";

class ChatNotFoundError extends ErrorFactory({
  name: "ChatNotFoundError",
  message: "Chat not found",
}) {}

describe("toError", () => {
  test("Error はそのまま返す", () => {
    const error = new Error("boom");
    expect(toError(error)).toBe(error);
  });

  test("Error 以外は UnexpectedError で包み、cause に保持する", () => {
    const error = toError("boom");
    expect(error).toBeInstanceOf(UnexpectedError);
    expect(error.cause).toBe("boom");
  });
});

describe("toOrpcError", () => {
  test("対応表にあるエラーは指定コードに変換する", () => {
    const error = toOrpcError(new ChatNotFoundError(), {
      ChatNotFoundError: "NOT_FOUND",
    });
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Chat not found");
  });

  test("対応表にないエラーは INTERNAL_SERVER_ERROR にしてメッセージを伏せる", () => {
    const error = toOrpcError(new Error("secret detail"));
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(error.message).not.toContain("secret detail");
  });

  test("ORPCError はそのまま返す", () => {
    const original = new ORPCError("FORBIDDEN");
    expect(toOrpcError(original)).toBe(original);
  });
});

describe("unwrapForOrpc", () => {
  test("成功なら値を返す", async () => {
    expect(await unwrapForOrpc(Result.succeed(42))).toBe(42);
  });

  test("非同期の Result も扱える", async () => {
    expect(await unwrapForOrpc(Promise.resolve(Result.succeed("ok")))).toBe(
      "ok",
    );
  });

  test("失敗なら ORPCError を throw する", async () => {
    const promise = unwrapForOrpc(Result.fail(new ChatNotFoundError()), {
      ChatNotFoundError: "NOT_FOUND",
    });
    await expect(promise).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("handleCliError", () => {
  const createIo = () => {
    const calls: { exitCode?: number; messages: string[] } = { messages: [] };
    const io = {
      exit: (code: number): never => {
        calls.exitCode = code;
        throw new Error("exit");
      },
      printError: (message: string) => {
        calls.messages.push(message);
      },
    };
    return { calls, io };
  };

  test("CliExit は指定コードで終了し、何も表示しない", () => {
    const { calls, io } = createIo();
    expect(() => handleCliError(new CliExit({ code: 2 }), io)).toThrow("exit");
    expect(calls.exitCode).toBe(2);
    expect(calls.messages).toEqual([]);
  });

  test("その他のエラーはメッセージを表示して 1 で終了する", () => {
    const { calls, io } = createIo();
    expect(() => handleCliError(new Error("boom"), io)).toThrow("exit");
    expect(calls.exitCode).toBe(1);
    expect(calls.messages).toEqual(["boom"]);
  });
});
