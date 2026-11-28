/**
 * 回答の出典（#258）。サーバ（回答の保存）と Web UI（ストリーミング中の表示）の両方で使うので、ほかに依存しない。
 *
 * Claude Code の Web 検索は別の呼び出しで行われ、本文のブロックに構造化された引用（citations）は付かない
 * （実機で確認した。docs/spikes/citations.md）。そのため、出典と本文の対応は Claude が本文に付けた印から決める。
 *
 * - Web 検索・Web ページ・Cosense・Slack: 根拠にした文・項目の末尾の `[出典](URL)`
 * - Monet の Wiki: これまでどおりの `[タイトル](wiki:ページID)`（#79）
 *
 * 印の URL・ページが、その回答のツールの結果（検索結果・取得したページ・読んだノートなど）や
 * 渡した参照資料に実際にあるときだけ、出典として番号を付ける。無い URL は通常のリンクのままにする。
 */

export type CitationKind = "web" | "cosense" | "slack" | "wiki";

export const CITATION_KIND_LABELS: Record<CitationKind, string> = {
  web: "Web",
  cosense: "Cosense",
  slack: "Slack",
  wiki: "Wiki",
};

/** 番号を付けた出典。 */
export type CitationSource = {
  /** 回答の中での番号（1 から。同じ出典は同じ番号）。 */
  n: number;
  kind: CitationKind;
  /** 開く先。Wiki は `wiki:<ページID>`。 */
  url: string;
  title?: string;
  /** 根拠の抜粋（取得できたとき）。 */
  excerpt?: string;
  /** Wiki のノート。 */
  pageId?: string;
  taskId?: string;
};

/** 回答に保存する出典（回答の metadata.citations）。 */
export type AnswerCitations = { sources: CitationSource[] };

/** Claude に出典の付け方を伝える指示（システムプロンプトに足す）。 */
export const CITATION_INSTRUCTIONS = [
  "Web 検索・Web ページの取得・Cosense・Slack などのツールで取得した資料を根拠に書いた文や箇条書きの項目では、その末尾に `[出典](URL)` の形で根拠にした資料の URL を付けてください。",
  "URL はツールの結果に含まれていたもの（検索結果の URL、取得したページの URL、Slack のメッセージのパーマリンク、Cosense のページの URL）をそのまま使い、推測で作らないでください。",
  "根拠が複数あれば `[出典](URL1)[出典](URL2)` のように並べます。根拠にしていない文には付けません。",
].join("\n");

/** 外部の出典の印。 */
const SOURCE_MARKER = /\[出典\]\(\s*<?(https?:\/\/[^)\s>]+)>?\s*\)/g;
/** Wiki の引用（#79）。 */
const WIKI_MARKER = /\[([^\]\n]+)\]\(\s*wiki:([^)\s]+)\s*\)/g;

const COSENSE_HOSTS = new Set(["scrapbox.io", "cosen.se"]);

const kindOfUrl = (url: URL): CitationKind => {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "slack.com" || host.endsWith(".slack.com")) return "slack";
  if (COSENSE_HOSTS.has(host)) return "cosense";
  return "web";
};

/**
 * URL を照合できる形にする。ホストは小文字、末尾の / とフラグメントは外す。
 * Cosense は scrapbox.io と cosen.se を同じものとし、ページ名のエンコードの違いをそろえる（#128）。
 */
export const normalizeUrl = (raw: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  let host = url.hostname.toLowerCase().replace(/^www\./, "");
  let path = url.pathname;
  if (COSENSE_HOSTS.has(host)) {
    host = "scrapbox.io";
    try {
      path = path
        .split("/")
        .map((segment) =>
          encodeURIComponent(decodeURIComponent(segment).replaceAll(" ", "_")),
        )
        .join("/");
    } catch {
      // デコードできなければそのまま
    }
  }
  path = path.length > 1 ? path.replace(/\/+$/, "") : "";
  return `${host}${path}${url.search}`;
};

type Found = {
  url: string;
  kind: CitationKind;
  title?: string;
  excerpt?: string;
};

const URL_PATTERN = /https?:\/\/[^\s"'<>()[\]{}`]+/g;
const trimUrl = (url: string) => url.replace(/[.,;:!?、。」）]+$/, "");

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

const shorten = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** JSON らしい文字列を読む（MCP の結果の text の中など）。読めなければ undefined。 */
const parseJson = (text: string): unknown => {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

/** オブジェクトの中の、URL とタイトル・本文を持つもの（検索結果・Slack のメッセージなど）を探す。 */
const walk = (value: unknown, add: (found: Found) => void, depth = 0) => {
  if (depth > 8 || value === null || typeof value !== "object") {
    if (typeof value === "string") {
      const parsed = parseJson(value);
      if (parsed !== undefined) walk(parsed, add, depth + 1);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, add, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const link = [record.permalink, record.url, record.link, record.href].find(
    (item): item is string =>
      typeof item === "string" && /^https?:\/\//.test(item),
  );
  const parsed = (() => {
    try {
      return link === undefined ? undefined : new URL(link);
    } catch {
      return undefined;
    }
  })();
  if (link !== undefined && parsed !== undefined) {
    const title = [
      record.title,
      record.name,
      record.channel_name,
      record.channel,
    ].find((item): item is string => typeof item === "string" && item !== "");
    const excerpt = [
      record.text,
      record.snippet,
      record.description,
      record.content,
    ].find((item): item is string => typeof item === "string" && item !== "");
    add({
      url: link,
      kind: kindOfUrl(parsed),
      ...(title === undefined ? {} : { title }),
      ...(excerpt === undefined ? {} : { excerpt: shorten(excerpt) }),
    });
  }
  // Cosense のページを読むツールの入力（プロジェクトとページ名）から、ページの URL を作る
  const project = [record.projectName, record.project].find(
    (item): item is string => typeof item === "string" && item !== "",
  );
  const page = [record.pageTitle, record.title].find(
    (item): item is string => typeof item === "string" && item !== "",
  );
  if (project !== undefined && page !== undefined && link === undefined) {
    add({
      url: `https://scrapbox.io/${project}/${encodeURIComponent(page.replaceAll(" ", "_"))}`,
      kind: "cosense",
      title: page,
    });
  }
  for (const child of Object.values(record)) walk(child, add, depth + 1);
};

/** Claude Code の WebSearch の結果（`Links: [{"title","url"}...]`）。 */
const webSearchLinks = (text: string): Found[] => {
  const match = /Links:\s*(\[[\s\S]*?\])\s*(?:\n|$)/.exec(text);
  const parsed = match?.[1] === undefined ? undefined : parseJson(match[1]);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    const url = (item as { url?: unknown }).url;
    const title = (item as { title?: unknown }).title;
    if (typeof url !== "string") return [];
    try {
      return [
        {
          url,
          kind: kindOfUrl(new URL(url)),
          ...(typeof title === "string" ? { title } : {}),
        },
      ];
    } catch {
      return [];
    }
  });
};

/** 回答のツールの呼び出し（入力と結果）。 */
export type ToolCall = { toolName: string; input: unknown; output: unknown };

/**
 * 回答のツールの入力・結果から、出典にできる資料（URL ごと）を集める。
 * 結果に無い URL（Claude が作った URL）は出典にしない。
 */
export const collectSources = (
  calls: readonly ToolCall[],
): Map<string, Found> => {
  const sources = new Map<string, Found>();
  const add = (found: Found) => {
    const key = normalizeUrl(found.url);
    if (key === undefined) return;
    const existing = sources.get(key);
    sources.set(key, {
      ...found,
      ...(existing?.title !== undefined && found.title === undefined
        ? { title: existing.title }
        : {}),
      ...(existing?.excerpt !== undefined && found.excerpt === undefined
        ? { excerpt: existing.excerpt }
        : {}),
    });
  };
  for (const call of calls) {
    const output = textOf(call.output);
    for (const found of webSearchLinks(output)) add(found);
    walk(call.output, add);
    walk(call.input, add);
    // 取得したページ（WebFetch など）と、結果の本文に出てくる URL
    for (const raw of [
      ...textOf(call.input).matchAll(URL_PATTERN),
      ...output.matchAll(URL_PATTERN),
    ]) {
      const url = trimUrl(raw[0]);
      const key = normalizeUrl(url);
      if (key === undefined || sources.has(key)) continue;
      try {
        add({ url, kind: kindOfUrl(new URL(url)) });
      } catch {
        // URL でなければ飛ばす
      }
    }
  }
  return sources;
};

/**
 * 本文の印に番号を付ける。出てきた順に、同じ出典には同じ番号を付ける。
 * wikiPages は参照資料として渡した・読んだノート（ID → タイトル）。
 */
export const buildCitations = (input: {
  text: string;
  calls: readonly ToolCall[];
  wikiTaskId?: string | undefined;
  wikiPages?: ReadonlyMap<string, string>;
}): AnswerCitations => {
  const available = collectSources(input.calls);
  const wikiPages = input.wikiPages ?? new Map<string, string>();
  const markers = [
    ...[...input.text.matchAll(SOURCE_MARKER)].map((match) => ({
      index: match.index,
      kind: "url" as const,
      value: match[1] ?? "",
    })),
    ...[...input.text.matchAll(WIKI_MARKER)].map((match) => ({
      index: match.index,
      kind: "wiki" as const,
      value: match[2] ?? "",
      label: match[1] ?? "",
    })),
  ].sort((a, b) => a.index - b.index);
  const sources: CitationSource[] = [];
  const numbered = new Map<string, number>();
  for (const marker of markers) {
    if (marker.kind === "wiki") {
      const key = `wiki:${marker.value}`;
      if (numbered.has(key) || !wikiPages.has(marker.value)) continue;
      const n = sources.length + 1;
      numbered.set(key, n);
      sources.push({
        n,
        kind: "wiki",
        url: key,
        title: wikiPages.get(marker.value) ?? marker.label,
        pageId: marker.value,
        ...(input.wikiTaskId === undefined ? {} : { taskId: input.wikiTaskId }),
      });
      continue;
    }
    const key = normalizeUrl(marker.value);
    if (key === undefined || numbered.has(key)) continue;
    const found = available.get(key);
    if (found === undefined) continue;
    const n = sources.length + 1;
    numbered.set(key, n);
    sources.push({
      n,
      kind: found.kind,
      url: marker.value,
      ...(found.title === undefined ? {} : { title: found.title }),
      ...(found.excerpt === undefined ? {} : { excerpt: found.excerpt }),
    });
  }
  return { sources };
};

/** 画面内の出典のリンク（Markdown の安全化で消されない、ページ内のフラグメント）。 */
export const CITATION_HREF_PREFIX = "#cite-";

/**
 * 本文の印を、出典のバッジ（`[n](#cite-n)`）に書き換える。
 * 出典にできなかった印のうち、外部の印は通常のリンクのまま、Wiki の印は文字だけ残す。
 */
export const linkCitations = (
  text: string,
  citations: AnswerCitations,
): string => {
  const byKey = new Map(
    citations.sources.map((source) => [
      source.kind === "wiki" ? source.url : normalizeUrl(source.url),
      source.n,
    ]),
  );
  return text
    .replace(SOURCE_MARKER, (whole, url: string) => {
      const n = byKey.get(normalizeUrl(url));
      return n === undefined ? whole : `[${n}](${CITATION_HREF_PREFIX}${n})`;
    })
    .replace(WIKI_MARKER, (_, label: string, id: string) => {
      const n = byKey.get(`wiki:${id}`);
      return n === undefined ? label : `[${n}](${CITATION_HREF_PREFIX}${n})`;
    });
};

/**
 * 画面内の出典のリンクの href から番号を取り出す。
 * Markdown の安全化でフラグメントに `user-content-` が付くので、それも受け付ける。
 */
export const citationNumberFromHref = (
  href: string | undefined,
): number | undefined => {
  const match = /^#(?:user-content-)?cite-(\d+)$/.exec(href ?? "");
  return match?.[1] === undefined ? undefined : Number(match[1]);
};
