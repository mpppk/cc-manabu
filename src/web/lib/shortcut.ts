/** キーボードショートカットの修飾キー。macOS などでは ⌘、それ以外では Ctrl を使う。 */
export const USE_COMMAND_SHORTCUT =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

/** 修飾キーの表示（⌘ / Ctrl+）。 */
export const MODIFIER_LABEL = USE_COMMAND_SHORTCUT ? "⌘" : "Ctrl+";

/** キー操作に、この OS のショートカットの修飾キー（⌘ か Ctrl）が付いているか（もう一方は付いていない）。 */
export const hasShortcutModifier = (event: {
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean =>
  USE_COMMAND_SHORTCUT
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
