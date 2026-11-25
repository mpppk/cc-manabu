import { describe, expect, test } from "bun:test";
import { createMemoryHistory } from "../../src/web/lib/app-history.ts";

describe("createMemoryHistory", () => {
  test("push で進み、back / forward で戻る・進むと購読者に知らせる", () => {
    const history = createMemoryHistory("/");
    const seen: string[] = [];
    history.listen(() => seen.push(history.location().pathname));
    history.push("/c/a");
    history.push("/t/b/wiki", { returnTo: "/c/a" });
    expect(history.location()).toEqual({ pathname: "/t/b/wiki", search: "" });
    expect(history.state()).toEqual({ returnTo: "/c/a" });
    history.back();
    history.back();
    history.back();
    history.forward();
    expect(seen).toEqual(["/c/a", "/", "/c/a"]);
    // push（listen は呼ばない）
    expect(seen).toHaveLength(3);
  });

  test("戻った位置から push すると、先の履歴を捨てる", () => {
    const history = createMemoryHistory("/");
    history.push("/c/a");
    history.push("/c/b");
    history.back();
    history.push("/c/c");
    history.forward();
    expect(history.location().pathname).toBe("/c/c");
    history.back();
    expect(history.location().pathname).toBe("/c/a");
  });

  test("replace はクエリも含めて今の項目を置き換える", () => {
    const history = createMemoryHistory("/tasks");
    history.replace("/tasks?status=active");
    expect(history.location()).toEqual({
      pathname: "/tasks",
      search: "?status=active",
    });
  });
});
