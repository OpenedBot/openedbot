import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { RUNTIME_MEMORY_DEFAULT_LIMITS } from "@openedbot/roster/domain/bot-memory";
import type { BotDto } from "@openedbot/contracts-api";
import { stripHandlePrefix } from "@openedbot/roster/domain/ask-user";
import { visibleRosterItems } from "@/lib/thread/thread-visibility";
import { api, queryKeys } from "../../lib/api";
import { listTimestamp } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { BotFace } from "../../components/bot-face";
import { useBotDialogs } from "../../lib/bots/bot-dialogs";

/**
 * The `/bot` home, when no thread is open, the contact register.
 *
 * One bot, one thread. There is no extra session anymore: the permanent thread
 * compacts instead of overflowing (`modules/conversation/src/domain/thread-compaction.ts`
 * memory, then a summary of the past, then the recent turns intact), so
 * splitting a task into a side thread no longer buys anything.
 *
 * The page is an index, not a presentation: a statement, then one
 * line per contact, and the action is on the line.
 */
export function ModeLanding() {
  const { t, locale } = useT();
  const openCreateBot = useBotDialogs((state) => state.openCreate);
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
  const operator = roster.data?.operator ?? null;
  const bots = useMemo<BotDto[]>(
    () => visibleRosterItems(roster.data?.bots ?? []).filter((bot) => bot.archivedAt == null),
    [roster.data],
  );
  const revealed = useReveal(bots.length > 0);

  const facts = [
    `1 ${t("modeLanding.bot.statThread")}`,
    `${RUNTIME_MEMORY_DEFAULT_LIMITS.memory} ${t("modeLanding.bot.statMemory")}`,
    `${RUNTIME_MEMORY_DEFAULT_LIMITS.user} ${t("modeLanding.bot.statFacts")}`,
  ];

  const newBot = (
    <button type="button" className="openedbot-mode-cta" onClick={() => openCreateBot()}>
      <Plus className="size-4" aria-hidden />
      {t("modeLanding.bot.cta")}
    </button>
  );

  return (
    <div className="openedbot-mode scrollbar-subtle flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className={revealed ? "openedbot-mode-guide in" : "openedbot-mode-guide"} data-kind="bot">
        <header className="openedbot-mode-head">
          <p className="openedbot-mode-eyebrow">{t("modeLanding.bot.eyebrow")}</p>
          {newBot}
        </header>
        <h1 className="openedbot-mode-title">
          {t("modeLanding.bot.title")}
          <em>{t("modeLanding.bot.accent")}</em>
        </h1>
        <p className="openedbot-mode-lead">{t("modeLanding.bot.lead")}</p>
        <p className="openedbot-mode-facts">
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </p>

        <section className="openedbot-mode-index" aria-labelledby="openedbot-mode-index-title">
          <h2 id="openedbot-mode-index-title" className="openedbot-mode-index-title">
            {t("modeLanding.bot.indexTitle")}
            <span>{t("modeLanding.bot.indexHint")}</span>
          </h2>

          {roster.isSuccess && bots.length === 0 ? (
            <div className="openedbot-mode-empty">
              <p>{t("modeLanding.bot.emptyTitle")}</p>
              <p>{t("modeLanding.bot.emptyBody")}</p>
              {newBot}
            </div>
          ) : null}

          <ul className="openedbot-mode-rows">
            {bots.map((bot, index) => (
              <li key={bot.id} className="openedbot-mode-row" style={{ ["--i" as string]: index }}>
                <Link to="/bot/$botId" params={{ botId: bot.id }} className="openedbot-mode-row-target">
                  <BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-9 shrink-0" />
                  <span className="openedbot-mode-row-text">
                    <strong>{bot.name}</strong>
                    <span>
                      {bot.preview
                        ? stripHandlePrefix(bot.preview, operator)
                        : t("modeLanding.bot.noPreview")}
                    </span>
                  </span>
                  <time className="openedbot-mode-row-meta" dateTime={bot.lastActivityAt}>
                    {listTimestamp(bot.lastActivityAt, undefined, locale)}
                  </time>
                  <ArrowRight className="openedbot-mode-row-go size-4" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

/**
 * The rows' appearance, once on mount. The motion lives in the CSS,
 * which cuts it under `prefers-reduced-motion`.
 */
function useReveal(ready: boolean): boolean {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!ready || revealed) return;
    const id = window.requestAnimationFrame(() => setRevealed(true));
    return () => window.cancelAnimationFrame(id);
  }, [ready, revealed]);
  return revealed;
}
