import path from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFunction } from "../../src/provider/types.ts";

const FIXTURE_DIR = path.join(
  import.meta.dir,
  "..",
  "fixtures",
  "sdk-messages",
);

type FixtureLine = SDKMessage | { type: "__error__"; message: string };

export const loadFixture = async (name: string): Promise<FixtureLine[]> => {
  const text = await Bun.file(path.join(FIXTURE_DIR, `${name}.jsonl`)).text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FixtureLine);
};

/**
 * fixture の SDKMessage を順に流す query()。`__error__` 行は例外として投げる。
 * 呼び出し時の prompt と options を記録する。
 */
export const createFakeQuery = (lines: FixtureLine[]) => {
  const calls: { prompt: unknown; options: Options | undefined }[] = [];
  const query: QueryFunction = ({ prompt, options }) => {
    calls.push({ prompt, options });
    return (async function* () {
      for (const line of lines) {
        // 実物と同じく、メッセージの間で他の処理が進めるようにする
        await Promise.resolve();
        if (line.type === "__error__") {
          throw new Error(line.message);
        }
        yield line;
      }
    })();
  };
  return { query, calls };
};
