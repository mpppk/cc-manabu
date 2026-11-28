/**
 * 左ペインの絞り込み（#256）。条件を AND／OR のグループで組み合わせる。
 *
 * 形は React Query Builder の RuleGroupType（combinator と rules）にそろえておき、
 * あとから条件の編集にライブラリを使っても、保存した条件をそのまま読めるようにする。
 */
import type { TaskStatus } from "../../db/schema.ts";
import { TASK_STATUS_LABELS, TASK_STATUS_ORDER } from "./task-status.ts";

export type FilterField =
  | "environment"
  | "taskStatus"
  | "threadState"
  | "archived";
export type FilterOperator = "=" | "!=";
export type FilterCombinator = "and" | "or";

export type FilterRule = {
  id: string;
  field: FilterField;
  operator: FilterOperator;
  value: string;
};

export type FilterGroup = {
  id: string;
  combinator: FilterCombinator;
  rules: (FilterRule | FilterGroup)[];
};

/** 環境が無い（未所属・環境の無いタスク）ことを表す値。 */
export const NO_ENVIRONMENT = "none";

/** スレッドの状態。生成中（承認待ちを含む）・正常に回答が終わって未読・既読。 */
export type ThreadState = "running" | "unread" | "read";
export const THREAD_STATES: readonly ThreadState[] = [
  "running",
  "unread",
  "read",
];
export const THREAD_STATE_LABELS: Record<ThreadState, string> = {
  running: "回答生成中",
  unread: "回答完了・未読",
  read: "回答完了・既読",
};

export const ARCHIVE_VALUES = ["archived", "active"] as const;
export const ARCHIVE_LABELS: Record<(typeof ARCHIVE_VALUES)[number], string> = {
  archived: "アーカイブ済み",
  active: "アーカイブされていない",
};

export const FIELD_LABELS: Record<FilterField, string> = {
  environment: "環境",
  taskStatus: "タスクの進捗",
  threadState: "スレッドの状態",
  archived: "スレッドのアーカイブ",
};
export const FIELDS: readonly FilterField[] = [
  "environment",
  "taskStatus",
  "threadState",
  "archived",
];

/** 条件の値の選択肢。環境は Monet に登録済みのものと「環境なし」。 */
export const valueOptions = (
  field: FilterField,
  environments: readonly { id: string; name: string }[],
): { value: string; label: string }[] => {
  switch (field) {
    case "environment":
      return [
        ...environments.map((environment) => ({
          value: environment.id,
          label: environment.name,
        })),
        { value: NO_ENVIRONMENT, label: "環境なし" },
      ];
    case "taskStatus":
      return TASK_STATUS_ORDER.map((status) => ({
        value: status,
        label: TASK_STATUS_LABELS[status],
      }));
    case "threadState":
      return THREAD_STATES.map((state) => ({
        value: state,
        label: THREAD_STATE_LABELS[state],
      }));
    case "archived":
      return ARCHIVE_VALUES.map((value) => ({
        value,
        label: ARCHIVE_LABELS[value],
      }));
  }
};

const newId = () => crypto.randomUUID();

export const emptyFilter = (): FilterGroup => ({
  id: newId(),
  combinator: "and",
  rules: [],
});

export const newRule = (
  field: FilterField,
  environments: readonly { id: string; name: string }[],
): FilterRule => ({
  id: newId(),
  field,
  operator: "=",
  value: valueOptions(field, environments)[0]?.value ?? "",
});

const isGroup = (item: FilterRule | FilterGroup): item is FilterGroup =>
  "rules" in item;

/** 絞り込みの対象（スレッド、またはスレッドの無いタスク）。 */
export type FilterSubject = {
  /** 所属タスクの環境（未所属・環境の無いタスクは null）。 */
  environmentId: string | null;
  /** 所属タスクの進捗（未所属は null）。 */
  taskStatus: TaskStatus | null;
  /** スレッドの状態。どれにも当たらない（エラー・まだ回答が無い）ときや、タスクだけのときは null。 */
  threadState: ThreadState | null;
  /** スレッドがアーカイブ済みか。タスクだけのときは false。 */
  archived: boolean;
};

const matchesRule = (rule: FilterRule, subject: FilterSubject): boolean => {
  const actual = (() => {
    switch (rule.field) {
      case "environment":
        return subject.environmentId ?? NO_ENVIRONMENT;
      case "taskStatus":
        return subject.taskStatus;
      case "threadState":
        return subject.threadState;
      case "archived":
        return subject.archived ? "archived" : "active";
    }
  })();
  return rule.operator === "=" ? actual === rule.value : actual !== rule.value;
};

/** 条件が 1 つも無いグループか（中の空のグループも条件なしとみなす）。 */
export const isEmptyFilter = (group: FilterGroup): boolean =>
  group.rules.every((item) => isGroup(item) && isEmptyFilter(item));

/** 条件に当てはまるか。空のグループは条件なし（すべてに当てはまる）とみなす。 */
export const matchesFilter = (
  group: FilterGroup,
  subject: FilterSubject,
): boolean => {
  const results = group.rules
    .filter((item) => !(isGroup(item) && isEmptyFilter(item)))
    .map((item) =>
      isGroup(item) ? matchesFilter(item, subject) : matchesRule(item, subject),
    );
  if (results.length === 0) return true;
  return group.combinator === "and"
    ? results.every(Boolean)
    : results.some(Boolean);
};

/** 条件に使っている項目。 */
export const fieldsOf = (group: FilterGroup): Set<FilterField> => {
  const fields = new Set<FilterField>();
  for (const item of group.rules) {
    if (isGroup(item)) for (const field of fieldsOf(item)) fields.add(field);
    else fields.add(item.field);
  }
  return fields;
};

/**
 * 通常の一覧に出すか。アーカイブの条件を指定していなければ、アーカイブしていないスレッドだけを出し、
 * 指定していれば、設定した式だけで決める。
 */
export const showsThread = (
  group: FilterGroup,
  subject: FilterSubject,
): boolean =>
  (fieldsOf(group).has("archived") || !subject.archived) &&
  matchesFilter(group, subject);

/**
 * スレッドが無くてもタスクを出すか。環境・タスクの進捗だけで絞り込んでいるときだけ、
 * 条件に合うタスクを出す（スレッドの状態・アーカイブはスレッドが無いと決まらないため）。
 */
export const showsTaskWithoutThreads = (
  group: FilterGroup,
  subject: Pick<FilterSubject, "environmentId" | "taskStatus">,
): boolean => {
  const fields = fieldsOf(group);
  if (fields.has("threadState") || fields.has("archived")) return false;
  return matchesFilter(group, {
    ...subject,
    threadState: null,
    archived: false,
  });
};

/**
 * スレッドの状態。分岐のどれかが生成中（承認待ちを含む）なら生成中を優先する。
 * 回答が正常に終わっていれば、分岐のどれかに新しい回答の印があれば未読、無ければ既読。
 * エラー・まだ回答が無いスレッドは null。
 */
export const threadStateOf = (
  branches: readonly {
    id: string;
    status: string;
    hasSession: boolean;
  }[],
  unread: ReadonlySet<string>,
): ThreadState | null => {
  if (
    branches.some(
      (chat) =>
        chat.status === "running" || chat.status === "awaiting_approval",
    )
  ) {
    return "running";
  }
  const completed = branches.filter(
    (chat) => chat.status === "idle" && chat.hasSession,
  );
  if (completed.length === 0) return null;
  return completed.some((chat) => unread.has(chat.id)) ? "unread" : "read";
};

/** 条件を読める文にする（例: 環境 = 開発 かつ（スレッドの状態 = 回答生成中 または …））。 */
export const describeFilter = (
  group: FilterGroup,
  environments: readonly { id: string; name: string }[],
  nested = false,
): string => {
  const parts = group.rules
    .filter((item) => !(isGroup(item) && isEmptyFilter(item)))
    .map((item) => {
      if (isGroup(item)) return describeFilter(item, environments, true);
      const label =
        valueOptions(item.field, environments).find(
          (option) => option.value === item.value,
        )?.label ?? "（不明）";
      return `${FIELD_LABELS[item.field]} ${item.operator === "=" ? "=" : "≠"} ${label}`;
    });
  if (parts.length === 0) return "条件なし";
  const text = parts.join(group.combinator === "and" ? " かつ " : " または ");
  return nested && parts.length > 1 ? `（${text}）` : text;
};

/** 保存した絞り込み。 */
export type SavedFilter = { id: string; name: string; filter: FilterGroup };

/** ブラウザに保存する絞り込みの状態。 */
export type FilterState = {
  /** 適用中の条件。 */
  current: FilterGroup;
  /** 適用中の条件を読み込んだ保存済みの絞り込み（無ければ undefined）。 */
  appliedId: string | undefined;
  saved: SavedFilter[];
};

const STATE_KEY = "monet.threadFilter";
// 改名前（#188）から使っている、進捗の複数選択（#195）の保存先
const LEGACY_STATUS_KEY = "cc-manabu.sidebarStatusFilter";

const isFilterGroup = (value: unknown): value is FilterGroup => {
  if (typeof value !== "object" || value === null) return false;
  const group = value as Partial<FilterGroup>;
  return (
    typeof group.id === "string" &&
    (group.combinator === "and" || group.combinator === "or") &&
    Array.isArray(group.rules) &&
    group.rules.every(
      (item) =>
        isFilterGroup(item) ||
        (typeof item === "object" &&
          item !== null &&
          typeof (item as FilterRule).id === "string" &&
          FIELDS.includes((item as FilterRule).field) &&
          ((item as FilterRule).operator === "=" ||
            (item as FilterRule).operator === "!=") &&
          typeof (item as FilterRule).value === "string"),
    )
  );
};

/** 以前の進捗の複数選択を、そのどれかに当てはまる条件にする。 */
export const fromLegacyStatuses = (
  statuses: readonly TaskStatus[],
): FilterGroup =>
  statuses.length === 0
    ? emptyFilter()
    : {
        id: newId(),
        combinator: "or",
        rules: statuses.map((status) => ({
          id: newId(),
          field: "taskStatus" as const,
          operator: "=" as const,
          value: status,
        })),
      };

const parseLegacyStatuses = (raw: string | null): TaskStatus[] => {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed)
      ? TASK_STATUS_ORDER.filter((status) => parsed.includes(status))
      : [];
  } catch {
    return [];
  }
};

/** 保存した状態を読む。まだ無ければ、以前の進捗の絞り込みを引き継ぐ。 */
export const parseFilterState = (
  raw: string | null,
  legacyStatuses: string | null,
): FilterState => {
  try {
    const parsed = JSON.parse(raw ?? "null") as Partial<FilterState> | null;
    if (parsed !== null && isFilterGroup(parsed.current)) {
      const saved = Array.isArray(parsed.saved)
        ? parsed.saved.filter(
            (item): item is SavedFilter =>
              typeof item?.id === "string" &&
              typeof item.name === "string" &&
              isFilterGroup(item.filter),
          )
        : [];
      return {
        current: parsed.current,
        appliedId: saved.some((item) => item.id === parsed.appliedId)
          ? parsed.appliedId
          : undefined,
        saved,
      };
    }
  } catch {
    // 読めなければ、以前の絞り込みから始める
  }
  return {
    current: fromLegacyStatuses(parseLegacyStatuses(legacyStatuses)),
    appliedId: undefined,
    saved: [],
  };
};

export const loadFilterState = (): FilterState => {
  try {
    return parseFilterState(
      localStorage.getItem(STATE_KEY),
      localStorage.getItem(LEGACY_STATUS_KEY),
    );
  } catch {
    return { current: emptyFilter(), appliedId: undefined, saved: [] };
  }
};

export const saveFilterState = (state: FilterState) => {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 覚えられなくても絞り込みはできる
  }
};

/** 2 つの条件が同じか（id は見ない）。適用中の保存済みの絞り込みを変えたかを見分ける。 */
export const sameFilter = (a: FilterGroup, b: FilterGroup): boolean => {
  const strip = (group: FilterGroup): unknown => ({
    combinator: group.combinator,
    rules: group.rules.map((item) =>
      isGroup(item)
        ? strip(item)
        : { field: item.field, operator: item.operator, value: item.value },
    ),
  });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

/** 条件の中のグループ・条件を、id で書き換える（不変）。 */
export const updateIn = (
  group: FilterGroup,
  id: string,
  update: (
    item: FilterRule | FilterGroup,
  ) => FilterRule | FilterGroup | undefined,
): FilterGroup => {
  if (group.id === id) {
    const next = update(group);
    return next !== undefined && isGroup(next) ? next : group;
  }
  return {
    ...group,
    rules: group.rules.flatMap((item) => {
      if (item.id === id) {
        const next = update(item);
        return next === undefined ? [] : [next];
      }
      return isGroup(item) ? [updateIn(item, id, update)] : [item];
    }),
  };
};

export { isGroup as isFilterGroupItem };
