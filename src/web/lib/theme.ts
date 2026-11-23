export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "cc-manabu:theme";

export const loadTheme = (): Theme => {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
};

/** テーマを <html> の class に反映する。system は OS の設定に従う。 */
export const applyTheme = (theme: Theme): void => {
  localStorage.setItem(STORAGE_KEY, theme);
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
};
