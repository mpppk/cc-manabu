import { MessageCircleQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/orpc.ts";
import { Markdown } from "./markdown.tsx";

type Qa = Awaited<ReturnType<ApiClient["wiki"]["qas"]>>[number];

/** 回答のあとに Q&A ができるまで読み直す間隔と回数。 */
const POLL_MS = 1000;
const POLL_TIMES = 10;

/**
 * Wiki ページへの質問と回答から作った Q&A の一覧（#159）。ページの本文の下に出す。
 * Q&A は回答のあとに作るので、revision が変わったら（質問・回答があったら）しばらく読み直す。
 */
export const PageQaList = ({
  api,
  taskId,
  pageId,
  revision,
}: {
  api: ApiClient;
  taskId: string;
  pageId: string;
  /** サイドチャットで質問・回答があるたびに変わる値。 */
  revision: number;
}) => {
  const [qas, setQas] = useState<Qa[]>([]);
  const count = useRef(0);
  count.current = qas.length;

  useEffect(() => {
    let active = true;
    setQas([]);
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

  if (qas.length === 0) return null;
  return (
    <section aria-label="Q&A" className="flex flex-col gap-3 border-t pt-4">
      <h3 className="flex items-center gap-1.5 font-semibold">
        <MessageCircleQuestion className="size-4" aria-hidden />
        Q&A
      </h3>
      <ul className="flex flex-col gap-3">
        {qas.map((qa) => (
          <li
            key={qa.id}
            data-qa-id={qa.id}
            className="flex flex-col gap-1 rounded-md border bg-muted/30 p-3 text-sm"
          >
            <p className="font-medium">
              <span className="mr-1 text-muted-foreground">Q.</span>
              {qa.question}
            </p>
            <div className="flex gap-1">
              <span className="text-muted-foreground">A.</span>
              <div className="min-w-0 flex-1">
                <Markdown text={qa.answer} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};
