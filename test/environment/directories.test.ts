import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { Result } from "@praha/byethrow";
import {
  expandDirectory,
  normalizeDirectories,
  normalizeDirectoriesAsync,
} from "../../src/environment/directories.ts";
import {
  createDirectoryPicker,
  type RunCommand,
} from "../../src/environment/directory-picker.ts";

describe("normalizeDirectories", () => {
  const existing = new Set(["/repo", "/docs", join(homedir(), "notes")]);
  const isDirectory = (path: string) => existing.has(path);

  test("~ を展開し、末尾の / を整え、重複を除く", () => {
    expect(
      normalizeDirectories(
        [" /repo/ ", "~/notes", "/docs", "/repo"],
        isDirectory,
      ),
    ).toEqual(Result.succeed(["/repo", join(homedir(), "notes"), "/docs"]));
    expect(expandDirectory("~", "/home/me")).toBe("/home/me");
  });

  test("相対パスと、無いディレクトリは受け付けない", () => {
    const relative = normalizeDirectories(["repo"], isDirectory);
    expect(Result.isFailure(relative) && relative.error.name).toBe(
      "RelativeDirectoryError",
    );
    const missing = normalizeDirectories(["/repo", "/missing"], isDirectory);
    expect(Result.isFailure(missing) && missing.error.message).toContain(
      "/missing",
    );
  });
});

describe("normalizeDirectoriesAsync", () => {
  test("ホームを引数で受け取り、非同期の確認で同じ規則を当てる", async () => {
    const deps = {
      home: "/Users/me",
      isDirectory: async (path: string) =>
        ["/repo", "/Users/me/notes"].includes(path),
    };
    expect(
      await normalizeDirectoriesAsync(["/repo/", "~/notes", "/repo"], deps),
    ).toEqual(Result.succeed(["/repo", "/Users/me/notes"]));
    const relative = await normalizeDirectoriesAsync(["repo"], deps);
    expect(Result.isFailure(relative) && relative.error.name).toBe(
      "RelativeDirectoryError",
    );
    const missing = await normalizeDirectoriesAsync(["/missing"], deps);
    expect(Result.isFailure(missing) && missing.error.name).toBe(
      "DirectoryNotFoundError",
    );
  });
});

describe("createDirectoryPicker", () => {
  const recording = (result: Awaited<ReturnType<RunCommand>>) => {
    const commands: string[][] = [];
    const run: RunCommand = async (command) => {
      commands.push(command);
      return result;
    };
    return { commands, run };
  };

  test("macOS では osascript で選び、末尾の改行を除いたパスを返す", async () => {
    const { commands, run } = recording({
      exitCode: 0,
      stdout: "/Users/me/repo/\n",
      stderr: "",
    });
    const pick = createDirectoryPicker({ platform: "darwin", run });
    expect(await pick()).toEqual(Result.succeed("/Users/me/repo/"));
    expect(commands[0]?.[0]).toBe("osascript");
  });

  test("キャンセルしたら null", async () => {
    const { run } = recording({
      exitCode: 1,
      stdout: "",
      stderr: "execution error: User canceled. (-128)",
    });
    const pick = createDirectoryPicker({ platform: "darwin", run });
    expect(await pick()).toEqual(Result.succeed(null));
  });

  test("Linux は zenity があれば使い、無ければ・Windows では使えない", async () => {
    const { commands, run } = recording({
      exitCode: 0,
      stdout: "/home/me/repo\n",
      stderr: "",
    });
    const withZenity = createDirectoryPicker({
      platform: "linux",
      which: () => "/usr/bin/zenity",
      run,
    });
    expect(await withZenity()).toEqual(Result.succeed("/home/me/repo"));
    expect(commands[0]?.[0]).toBe("zenity");

    for (const picker of [
      createDirectoryPicker({ platform: "linux", which: () => null, run }),
      createDirectoryPicker({ platform: "win32", run }),
    ]) {
      const result = await picker();
      expect(Result.isFailure(result) && result.error.name).toBe(
        "DirectoryPickerUnavailableError",
      );
    }
  });

  test("ダイアログがエラーで終わったら失敗にする", async () => {
    const { run } = recording({
      exitCode: 1,
      stdout: "",
      stderr: "execution error: something else (-1700)",
    });
    const result = await createDirectoryPicker({ platform: "darwin", run })();
    expect(Result.isFailure(result) && result.error.name).toBe(
      "DirectoryPickerError",
    );
  });
});
