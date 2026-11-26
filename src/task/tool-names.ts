/**
 * Claude がタスクの進捗と関連リンクを読み書きするツールの名前（#187）。
 * サーバと Web UI の両方で使うので、ほかに依存しない。
 */

/** MCP サーバの名前。ツール名は `mcp__task__<ツール>` になる。 */
export const TASK_MCP_SERVER_NAME = "task";

const toolName = (name: string) => `mcp__${TASK_MCP_SERVER_NAME}__${name}`;

/** Claude が使うタスクのツールの名前（canUseTool・ツールの表示に届く名前）。 */
export const TASK_TOOL_NAMES = {
  getTask: toolName("get_task"),
  updateTask: toolName("update_task"),
  addLink: toolName("add_link"),
  updateLink: toolName("update_link"),
} as const;

/** 承認なしで使える、読むだけのツール。 */
export const TASK_READ_TOOL_NAMES: readonly string[] = [
  TASK_TOOL_NAMES.getTask,
];

/** 画面に出す、タスクのツールの名前。タスクのツールでなければ undefined。 */
export const taskToolLabel = (name: string): string | undefined => {
  switch (name) {
    case TASK_TOOL_NAMES.getTask:
      return "タスク: 情報を読む";
    case TASK_TOOL_NAMES.updateTask:
      return "タスク: 進捗を更新";
    case TASK_TOOL_NAMES.addLink:
      return "タスク: 関連リンクを追加";
    case TASK_TOOL_NAMES.updateLink:
      return "タスク: 関連リンクを編集";
    default:
      return undefined;
  }
};
