/**
 * 画面の現在地（パスとクエリ）と、その移動。
 *
 * ブラウザ版はアドレスバーの URL（History API）を使う。デスクトップアプリ版（artifact）は
 * ページの URL を自由に変えられないので、メモリ上の履歴に差し替える。
 */
export type AppHistory = {
  /** 今のパス（`/c/<id>` など）とクエリ（`?status=...`、無ければ空文字）。 */
  location: () => { pathname: string; search: string };
  /** 移動するときに渡した state。 */
  state: () => unknown;
  /** 新しい項目として移動する。 */
  push: (url: string, state?: unknown) => void;
  /** 今の項目を置き換える（戻るの対象にしない）。 */
  replace: (url: string, state?: unknown) => void;
  /** 戻る・進むで現在地が変わったときに呼ぶ。購読をやめる関数を返す。 */
  listen: (onChange: () => void) => () => void;
};

export const browserHistory: AppHistory = {
  location: () => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }),
  state: () => window.history.state,
  push: (url, state) => window.history.pushState(state ?? null, "", url),
  replace: (url, state) => window.history.replaceState(state ?? null, "", url),
  listen: (onChange) => {
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  },
};

type Entry = { pathname: string; search: string; state: unknown };

const parse = (url: string, state: unknown): Entry => {
  const parsed = new URL(url, "memory://app");
  return { pathname: parsed.pathname, search: parsed.search, state };
};

/** メモリ上の履歴。`back()` / `forward()` で戻る・進む（マウスの戻るボタンなどに割り当てる）。 */
export const createMemoryHistory = (
  initial = "/",
): AppHistory & { back: () => void; forward: () => void } => {
  const entries: Entry[] = [parse(initial, null)];
  let index = 0;
  const listeners = new Set<() => void>();
  const current = (): Entry => entries[index] ?? parse("/", null);
  const move = (delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= entries.length) return;
    index = next;
    for (const listener of listeners) listener();
  };
  return {
    location: () => ({
      pathname: current().pathname,
      search: current().search,
    }),
    state: () => current().state,
    push: (url, state) => {
      entries.splice(index + 1, entries.length, parse(url, state ?? null));
      index = entries.length - 1;
    },
    replace: (url, state) => {
      entries[index] = parse(url, state ?? null);
    },
    listen: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    back: () => move(-1),
    forward: () => move(1),
  };
};

let active: AppHistory = browserHistory;

/** 画面が使う履歴。 */
export const appHistory = (): AppHistory => active;

/** 履歴を差し替える。画面を描く前に 1 回だけ呼ぶ。 */
export const setAppHistory = (history: AppHistory): void => {
  active = history;
};
