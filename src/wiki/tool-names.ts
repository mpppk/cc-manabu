/**
 * Claude が Wiki を読み書きするツールの名前。サーバと Web UI の両方で使うので、ほかに依存しない。
 */

/** MCP サーバの名前。ツール名は `mcp__wiki__<ツール>` になる。 */
export const WIKI_MCP_SERVER_NAME = "wiki";

const toolName = (name: string) => `mcp__${WIKI_MCP_SERVER_NAME}__${name}`;

/** Claude が使う Wiki のツールの名前（canUseTool・ツールの表示に届く名前）。 */
export const WIKI_TOOL_NAMES = {
  listPages: toolName("list_pages"),
  readPage: toolName("read_page"),
  createPage: toolName("create_page"),
  updatePage: toolName("update_page"),
  editPage: toolName("edit_page"),
} as const;

/** 承認なしで使える、読むだけのツール。 */
export const WIKI_READ_TOOL_NAMES: readonly string[] = [
  WIKI_TOOL_NAMES.listPages,
  WIKI_TOOL_NAMES.readPage,
];

/** 画面に出す、Wiki のツールの名前。Wiki のツールでなければ undefined。 */
export const wikiToolLabel = (name: string): string | undefined => {
  switch (name) {
    case WIKI_TOOL_NAMES.listPages:
      return "Wiki: ページの一覧";
    case WIKI_TOOL_NAMES.readPage:
      return "Wiki: ページを読む";
    case WIKI_TOOL_NAMES.createPage:
      return "Wiki: ページを作成";
    case WIKI_TOOL_NAMES.updatePage:
      return "Wiki: ページを更新";
    case WIKI_TOOL_NAMES.editPage:
      return "Wiki: ページを編集";
    default:
      return undefined;
  }
};
