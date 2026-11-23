import { MessageSquarePlus, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatUIMessage } from "../chat/chat-service.ts";
import type { ChatDto } from "../router.ts";
import { ChatView } from "./components/chat-view.tsx";
import { Button } from "./components/ui/button.tsx";
import type { ApiClient } from "./lib/orpc.ts";
import { applyTheme, loadTheme, type Theme } from "./lib/theme.ts";

type Status = Awaited<ReturnType<ApiClient["system"]["status"]>>;

const ClaudeStatusBadge = ({ status }: { status: Status | undefined }) => {
  if (status === undefined) {
    return <span className="text-muted-foreground text-xs">接続中…</span>;
  }
  const claude = status.claude;
  switch (claude.state) {
    case "checking":
      return (
        <span className="text-muted-foreground text-xs">
          Claude Code を確認中…
        </span>
      );
    case "ready":
      return (
        <span className="text-muted-foreground text-xs">
          Claude Code {claude.version ?? ""}
          {claude.account.subscriptionType
            ? `・${claude.account.subscriptionType}`
            : ""}
        </span>
      );
    case "not_installed":
    case "error":
      return (
        <span className="text-destructive text-xs" role="alert">
          {claude.message}
        </span>
      );
  }
};

/** 画面全体のレイアウト。サイドバー（#36）とチャット画面（#35 以降）はここに入る。 */
export const App = ({ api }: { api: ApiClient }) => {
  const [status, setStatus] = useState<Status>();
  const [current, setCurrent] = useState<{
    chat: ChatDto;
    messages: ChatUIMessage[];
  }>();

  const openChat = async (id: string) => {
    const { chat, messages } = await api.chats.get({ id });
    setCurrent({ chat, messages: messages as ChatUIMessage[] });
  };

  const newChat = async () => {
    const chat = await api.chats.create({});
    await openChat(chat.id);
  };
  const [theme, setTheme] = useState<Theme>(loadTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const next = await api.system.status();
      if (cancelled) return;
      setStatus(next);
      // Claude Code を確認中なら、終わるまで問い合わせる
      if (next.claude.state === "checking") {
        setTimeout(poll, 1000);
      }
    };
    poll().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="flex items-center justify-between p-3">
          <span className="font-semibold">cc-manabu</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="新しい会話"
            onClick={() => void newChat()}
          >
            <MessageSquarePlus />
          </Button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2" aria-label="会話一覧" />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-between border-b px-4">
          <span className="truncate text-muted-foreground text-sm">
            {status?.cwd ?? ""}
          </span>
          <div className="flex items-center gap-3">
            <ClaudeStatusBadge status={status} />
            <Button
              variant="ghost"
              size="icon"
              aria-label="テーマを切り替える"
              onClick={() =>
                setTheme(
                  document.documentElement.classList.contains("dark")
                    ? "light"
                    : "dark",
                )
              }
            >
              <Sun className="dark:hidden" />
              <Moon className="hidden dark:block" />
            </Button>
          </div>
        </header>
        {current === undefined ? (
          <section className="flex flex-1 items-center justify-center text-muted-foreground">
            会話を選ぶか、新しい会話を始めてください。
          </section>
        ) : (
          <ChatView
            key={current.chat.id}
            api={api}
            chat={current.chat}
            initialMessages={current.messages}
          />
        )}
      </main>
    </div>
  );
};
