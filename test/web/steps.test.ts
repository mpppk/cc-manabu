import { describe, expect, test } from "bun:test";
import { describeSteps, groupSteps } from "../../src/web/lib/steps.ts";

type Part = { type: string; name?: string };

const isStep = (part: Part) =>
  part.type === "reasoning" || part.type === "tool";
const isSkipped = (part: Part) => part.type === "step-start";

describe("groupSteps", () => {
  test("続けて行った思考・ツールの実行を 1 つのまとまりにする", () => {
    const parts: Part[] = [
      { type: "reasoning" },
      { type: "step-start" },
      { type: "tool", name: "Bash" },
      { type: "tool", name: "Skill" },
      { type: "text" },
      { type: "tool", name: "Bash" },
      { type: "text" },
    ];
    const segments = groupSteps(parts, isStep, isSkipped);
    expect(segments.map((s) => s.kind)).toEqual([
      "steps",
      "single",
      "single",
      "single",
    ]);
    const [first] = segments;
    // step-start は飛ばし、区切りにもしない。元の位置（index）を保つ
    expect(
      first?.kind === "steps" ? first.items.map((i) => i.index) : [],
    ).toEqual([0, 2, 3]);
  });

  test("1 つだけの手順はまとめない", () => {
    expect(
      groupSteps([{ type: "text" }, { type: "tool" }], isStep, isSkipped).map(
        (s) => s.kind,
      ),
    ).toEqual(["single", "single"]);
  });
});

test("describeSteps は種類ごとの数を、最初に出てきた順に並べる", () => {
  expect(describeSteps(["思考", "Bash", "思考", "Skill", "Bash"])).toBe(
    "思考 2・Bash 2・Skill 1",
  );
});
