import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { RUNTIME_MEMORY_DEFAULT_LIMITS } from "@openedbot/roster/domain/bot-memory";
import type { BotDto } from "@openedbot/contracts-api";
import { stripHandlePrefix } from "@openedbot/roster/domain/ask-user";
import { visibleRosterItems } from "@/lib/thread-visibility";
import { api, queryKeys } from "../../lib/api";
import { listTimestamp } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { BotFace } from "../../components/bot-face";
import { useBotDialogs } from "../../lib/bot-dialogs";

/**
 * L'accueil de `/bot`, quand aucun fil n'est ouvert, le registre des
 * contacts.
 *
 * Un bot, un fil. Il n'y a plus de session extra : le fil permanent se
 * compacte au lieu de déborder (`modules/conversation/src/domain/thread-compaction.ts`
 * mémoire, puis résumé du passé, puis les tours récents intacts), donc
 * découper une tâche dans un fil à côté n'achète plus rien.
 *
 * La page est un index, pas une présentation : une affirmation, puis une
 * ligne par contact, et l'action est sur la ligne.
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
    <button type="button" className="ohb-mode-cta" onClick={() => openCreateBot()}>
      <Plus className="size-4" aria-hidden />
      {t("modeLanding.bot.cta")}
    </button>
  );

  return (
    <div className="ohb-mode scrollbar-subtle flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className={revealed ? "ohb-mode-guide in" : "ohb-mode-guide"} data-kind="bot">
        <header className="ohb-mode-head">
          <p className="ohb-mode-eyebrow">{t("modeLanding.bot.eyebrow")}</p>
          {newBot}
        </header>
        <h1 className="ohb-mode-title">
          {t("modeLanding.bot.title")}
          <em>{t("modeLanding.bot.accent")}</em>
        </h1>
        <p className="ohb-mode-lead">{t("modeLanding.bot.lead")}</p>
        <p className="ohb-mode-facts">
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </p>

        <section className="ohb-mode-index" aria-labelledby="ohb-mode-index-title">
          <h2 id="ohb-mode-index-title" className="ohb-mode-index-title">
            {t("modeLanding.bot.indexTitle")}
            <span>{t("modeLanding.bot.indexHint")}</span>
          </h2>

          {roster.isSuccess && bots.length === 0 ? (
            <div className="ohb-mode-empty">
              <p>{t("modeLanding.bot.emptyTitle")}</p>
              <p>{t("modeLanding.bot.emptyBody")}</p>
              {newBot}
            </div>
          ) : null}

          <ul className="ohb-mode-rows">
            {bots.map((bot, index) => (
              <li key={bot.id} className="ohb-mode-row" style={{ ["--i" as string]: index }}>
                <Link to="/bot/$botId" params={{ botId: bot.id }} className="ohb-mode-row-target">
                  <BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-9 shrink-0" />
                  <span className="ohb-mode-row-text">
                    <strong>{bot.name}</strong>
                    <span>
                      {bot.preview
                        ? stripHandlePrefix(bot.preview, operator)
                        : t("modeLanding.bot.noPreview")}
                    </span>
                  </span>
                  <time className="ohb-mode-row-meta" dateTime={bot.lastActivityAt}>
                    {listTimestamp(bot.lastActivityAt, undefined, locale)}
                  </time>
                  <ArrowRight className="ohb-mode-row-go size-4" aria-hidden />
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
 * L'apparition des lignes, une fois au montage. Le mouvement vit dans la CSS,
 * qui le coupe sous `prefers-reduced-motion`.
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
