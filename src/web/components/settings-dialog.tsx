import type { ClaudeStatus } from "../../claude/status.ts";
import type { Theme } from "../lib/theme.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogFooter } from "./ui/dialog.tsx";

const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "ライト" },
  { value: "dark", label: "ダーク" },
  { value: "system", label: "OS の設定に合わせる" },
];

/** Claude Code の情報（バージョン・契約プラン）。 */
const ClaudeInfo = ({ claude }: { claude: ClaudeStatus | undefined }) => {
  if (claude === undefined || claude.state === "checking") {
    return <p className="text-muted-foreground">Claude Code を確認中…</p>;
  }
  if (claude.state === "not_installed") {
    return (
      <p className="text-destructive" role="alert">
        {claude.message}
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-muted-foreground">バージョン</dt>
      <dd>{claude.version ?? "不明"}</dd>
      {claude.state === "ready" ? (
        <>
          <dt className="text-muted-foreground">契約プラン</dt>
          <dd>{claude.account.subscriptionType || "不明"}</dd>
        </>
      ) : (
        <>
          <dt className="text-muted-foreground">状態</dt>
          <dd className="text-destructive">{claude.message}</dd>
        </>
      )}
    </dl>
  );
};

/**
 * 設定の「一般」（#170）。Claude Code のバージョン・契約プランと、テーマの切り替え。
 * 会話を開いたまま重ねて開き、閉じると元の画面に戻る。テーマはすぐ反映し、次回の起動でも使う。
 */
export const GeneralSettingsDialog = ({
  open,
  onClose,
  claude,
  theme,
  onThemeChange,
}: {
  open: boolean;
  onClose: () => void;
  claude: ClaudeStatus | undefined;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) => (
  <Dialog
    open={open}
    onOpenChange={(next) => {
      if (!next) onClose();
    }}
    title="一般"
    description="monet 全体の設定です。"
  >
    <section aria-label="Claude Code" className="grid gap-2 text-sm">
      <h3 className="font-medium">Claude Code</h3>
      <ClaudeInfo claude={claude} />
    </section>
    <fieldset className="grid gap-2 text-sm">
      <legend className="mb-1 font-medium">テーマ</legend>
      {THEMES.map((option) => (
        <label key={option.value} className="flex items-center gap-2">
          <input
            type="radio"
            name="theme"
            value={option.value}
            checked={theme === option.value}
            onChange={() => onThemeChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
    <DialogFooter>
      <Button variant="outline" onClick={onClose}>
        閉じる
      </Button>
    </DialogFooter>
  </Dialog>
);
