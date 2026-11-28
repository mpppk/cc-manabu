import { describe, expect, test } from "bun:test";
import {
  describeFilter,
  type FilterGroup,
  type FilterSubject,
  fromLegacyStatuses,
  matchesFilter,
  parseFilterState,
  sameFilter,
  showsTaskWithoutThreads,
  showsThread,
  threadStateOf,
  updateIn,
} from "../../src/web/lib/thread-filter.ts";

const rule = (
  field: FilterGroup["rules"][number] extends infer R
    ? R extends { field: infer F }
      ? F
      : never
    : never,
  value: string,
  operator: "=" | "!=" = "=",
) => ({ id: crypto.randomUUID(), field, operator, value });

const subject = (overrides: Partial<FilterSubject> = {}): FilterSubject => ({
  environmentId: "dev",
  taskStatus: "in_progress",
  threadState: "read",
  archived: false,
  ...overrides,
});

/** 環境 = 開発 AND（回答生成中 OR 回答完了・未読） */
const devActive: FilterGroup = {
  id: "root",
  combinator: "and",
  rules: [
    rule("environment", "dev"),
    {
      id: "g",
      combinator: "or",
      rules: [rule("threadState", "running"), rule("threadState", "unread")],
    },
  ],
};
const environments = [{ id: "dev", name: "開発" }];

describe("絞り込みの条件（#256）", () => {
  test("AND と OR のグループを組み合わせて当てはめる", () => {
    expect(matchesFilter(devActive, subject({ threadState: "running" }))).toBe(
      true,
    );
    expect(matchesFilter(devActive, subject({ threadState: "unread" }))).toBe(
      true,
    );
    expect(matchesFilter(devActive, subject({ threadState: "read" }))).toBe(
      false,
    );
    expect(
      matchesFilter(
        devActive,
        subject({ environmentId: null, threadState: "running" }),
      ),
    ).toBe(false);
    expect(
      matchesFilter(
        { id: "r", combinator: "and", rules: [rule("environment", "none")] },
        subject({ environmentId: null }),
      ),
    ).toBe(true);
    expect(
      matchesFilter(
        {
          id: "r",
          combinator: "and",
          rules: [rule("threadState", "read", "!=")],
        },
        subject({ threadState: "unread" }),
      ),
    ).toBe(true);
  });

  test("空の条件・空のグループは条件なし", () => {
    const empty: FilterGroup = {
      id: "r",
      combinator: "and",
      rules: [{ id: "g", combinator: "or", rules: [] }],
    };
    expect(matchesFilter(empty, subject())).toBe(true);
    expect(describeFilter(empty, environments)).toBe("条件なし");
  });

  test("アーカイブの条件が無ければアーカイブしたスレッドを出さず、あれば式だけで決める", () => {
    expect(
      showsThread(
        devActive,
        subject({ threadState: "running", archived: true }),
      ),
    ).toBe(false);
    const archived: FilterGroup = {
      id: "r",
      combinator: "and",
      rules: [rule("archived", "archived")],
    };
    expect(showsThread(archived, subject({ archived: true }))).toBe(true);
    expect(showsThread(archived, subject({ archived: false }))).toBe(false);
  });

  test("環境・進捗だけの絞り込みでは、スレッドの無いタスクも条件で出す", () => {
    const byStatus = fromLegacyStatuses(["in_progress", "on_hold"]);
    expect(
      showsTaskWithoutThreads(byStatus, {
        environmentId: "x",
        taskStatus: "on_hold",
      }),
    ).toBe(true);
    expect(
      showsTaskWithoutThreads(byStatus, {
        environmentId: "x",
        taskStatus: "done",
      }),
    ).toBe(false);
    expect(
      showsTaskWithoutThreads(devActive, {
        environmentId: "dev",
        taskStatus: "done",
      }),
    ).toBe(false);
  });

  test("スレッドの状態は生成中を優先し、正常に終わった回答の未読・既読で決める", () => {
    const unread = new Set(["b"]);
    expect(
      threadStateOf(
        [
          { id: "a", status: "idle", hasSession: true },
          { id: "b", status: "awaiting_approval", hasSession: true },
        ],
        unread,
      ),
    ).toBe("running");
    expect(
      threadStateOf(
        [
          { id: "a", status: "idle", hasSession: true },
          { id: "b", status: "idle", hasSession: true },
        ],
        unread,
      ),
    ).toBe("unread");
    expect(
      threadStateOf([{ id: "a", status: "idle", hasSession: true }], unread),
    ).toBe("read");
    expect(
      threadStateOf([{ id: "a", status: "error", hasSession: true }], unread),
    ).toBeNull();
    expect(
      threadStateOf([{ id: "a", status: "idle", hasSession: false }], unread),
    ).toBeNull();
  });

  test("条件を読める文にする", () => {
    expect(describeFilter(devActive, environments)).toBe(
      "環境 = 開発 かつ （スレッドの状態 = 回答生成中 または スレッドの状態 = 回答完了・未読）",
    );
  });

  test("以前の進捗の複数選択を、そのどれかに当てはまる条件として引き継ぐ", () => {
    const state = parseFilterState(null, JSON.stringify(["on_hold", "done"]));
    expect(state.saved).toEqual([]);
    expect(
      sameFilter(state.current, fromLegacyStatuses(["on_hold", "done"])),
    ).toBe(true);
    expect(matchesFilter(state.current, subject({ taskStatus: "done" }))).toBe(
      true,
    );
    // 新しい形で保存していれば、そちらを使う
    const saved = { id: "s", name: "開発", filter: devActive };
    const restored = parseFilterState(
      JSON.stringify({ current: devActive, appliedId: "s", saved: [saved] }),
      JSON.stringify(["done"]),
    );
    expect(restored.appliedId).toBe("s");
    expect(sameFilter(restored.current, devActive)).toBe(true);
    expect(parseFilterState("{broken", null).current.rules).toEqual([]);
  });

  test("条件を id で書き換え・取り除く", () => {
    const changed = updateIn(devActive, "g", (item) =>
      "rules" in item ? { ...item, combinator: "and" } : item,
    );
    expect(describeFilter(changed, environments)).toContain("かつ （");
    const removed = updateIn(devActive, "g", () => undefined);
    expect(describeFilter(removed, environments)).toBe("環境 = 開発");
    expect(sameFilter(devActive, changed)).toBe(false);
  });
});
