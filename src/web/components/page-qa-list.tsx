import {
  ChevronRight,
  MessageCircleQuestion,
  MessagesSquare,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WikiPageDto } from "../../router.ts";
import type { ApiClient } from "../lib/orpc.ts";
import { cn } from "../lib/utils.ts";
import { Markdown } from "./markdown.tsx";
import {
  useNoteTerms,
  type WikiNoteTerms,
  type WikiSelectionActions,
  WikiSelectionArea,
} from "./wiki-pane.tsx";
import { WikiTermsContext } from "./wiki-term.tsx";

type Qa = Awaited<ReturnType<ApiClient["wiki"]["qas"]>>[number];

/** 回答のあとに Q&A ができるまで読み直す間隔と回数。 */
const POLL_MS = 1000;
const POLL_TIMES = 10;

/** 選択範囲の対象にする要素の属性（値は Q&A の id）。 */
const QA_ATTRIBUTE = "data-wiki-qa";

/**
 * Wiki ページへの質問と回答から作った Q&A の一覧（#159）。ページの本文の下に出す。
 * Q&A は回答のあとに作るので、revision が変わったら（質問・回答があったら）しばらく読み直す。
 *
 * 開いた直後は質問だけを並べ、項目ごとに回答と元のスレッドへのリンクを開閉する（#205）。
 * 読み直しても開閉状態は保ち、新しい項目は閉じた状態で足す。質問・回答の文は、本文と同じく
 * 選択して質問・ノートの作成ができ、用語から説明とノートを開ける。
 */
export const PageQaList = ({
  api,
  taskId,
  page,
  revision,
  selectionActions,
  terms,
  onOpenAnswer,
}: {
  api: ApiClient;
  taskId: string;
  page: Pick<WikiPageDto, "id" | "title">;
  /** サイドチャットで質問・回答があるたびに変わる値。 */
  revision: number;
  /** 質問・回答の選択範囲から、質問・ノートの作成をできるようにする。 */
  selectionActions?: WikiSelectionActions | undefined;
  /** 質問・回答の用語から、説明とノートを開けるようにする。 */
  terms?: WikiNoteTerms | undefined;
  /** Q&A の元の会話を開き、その回答へ移る。 */
  onOpenAnswer?: ((chatId: string, messageId: string) => void) | undefined;
}) => {
  const pageId = page.id;
  const [qas, setQas] = useState<Qa[]>([]);
  /** 回答を開いている Q&A の id。 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const count = useRef(0);
  count.current = qas.length;
  const { termMatcher, termsContext } = useNoteTerms(terms, pageId);

  useEffect(() => {
    let active = true;
    setQas([]);
    setExpanded(new Set());
    api.wiki.qas({ taskId, pageId }).then(
      (loaded) => {
        if (active) setQas(loaded);
      },
      () => {
        // 読み込めなくてもページは読める
      },
    );
    return () => {
      active = false;
    };
  }, [api, taskId, pageId]);

  const seen = useRef(revision);
  useEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    const before = count.current;
    let times = 0;
    let active = true;
    const poll = async () => {
      times++;
      const loaded = await api.wiki.qas({ taskId, pageId }).catch(() => null);
      if (!active) return;
      if (loaded !== null) setQas(loaded);
      if ((loaded === null || loaded.length === before) && times < POLL_TIMES) {
        timer = setTimeout(() => void poll(), POLL_MS);
      }
    };
    let timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, taskId, pageId, revision]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const text = (qa: Qa, value: string) => (
    <div data-wiki-qa={qa.id} className="min-w-0 flex-1">
      <Markdown
        text={value}
        {...(termMatcher === undefined ? {} : { termMatcher })}
      />
    </div>
  );

  if (qas.length === 0) return null;
  return (
    <section aria-label="Q&A" className="flex flex-col gap-3 border-t pt-4">
      <h3 className="flex items-center gap-1.5 font-semibold">
        <MessageCircleQuestion className="size-4" aria-hidden />
        Q&A
      </h3>
      <WikiTermsContext.Provider value={termsContext}>
        <WikiSelectionArea
          page={page}
          actions={selectionActions}
          attribute={QA_ATTRIBUTE}
          qa
        >
          <ul className="flex flex-col gap-2">
            {qas.map((qa) => {
              const open = expanded.has(qa.id);
              const answerId = `qa-answer-${qa.id}`;
              return (
                <li
                  key={qa.id}
                  data-qa-id={qa.id}
                  className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 text-sm"
                >
                  <div className="flex items-start gap-1 font-medium">
                    <button
                      type="button"
                      className="-my-0.5 -ml-1 shrink-0 rounded-sm p-0.5 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={open}
                      aria-controls={answerId}
                      aria-label={open ? "回答を閉じる" : "回答を開く"}
                      title={open ? "回答を閉じる" : "回答を開く"}
                      onClick={() => toggle(qa.id)}
                    >
                      <ChevronRight
                        className={cn(
                          "size-4 transition-transform",
                          open && "rotate-90",
                        )}
                        aria-hidden
                      />
                    </button>
                    <span className="text-muted-foreground">Q.</span>
                    {text(qa, qa.question)}
                  </div>
                  {open && (
                    <div id={answerId} className="flex flex-col gap-2 pl-6">
                      <div className="flex gap-1">
                        <span className="text-muted-foreground">A.</span>
                        {text(qa, qa.answer)}
                      </div>
                      {onOpenAnswer !== undefined && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 self-start text-primary text-xs underline-offset-2 hover:underline"
                          onClick={() => onOpenAnswer(qa.chatId, qa.messageId)}
                        >
                          <MessagesSquare className="size-3.5" aria-hidden />
                          元のスレッドを開く
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </WikiSelectionArea>
      </WikiTermsContext.Provider>
    </section>
  );
};
