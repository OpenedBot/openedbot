import { RiAddLine } from "@remixicon/react";
import { ageSince } from "@openedbot/browser-i18n";
import { cn } from "@openedbot/browser-ui-kit";
import type { SupportThreadSummaryDto } from "@openedbot/contracts-api";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";

/**
 * Les fils de ce visiteur, du plus récent au plus ancien, et la seule porte
 * vers un fil neuf : la liste en place du fil (carte, mobile, page étroite).
 */
export function SupportHistoryList({
  history,
  onPick,
  onNew,
}: {
  history: readonly SupportThreadSummaryDto[];
  onPick: (conversationId: string) => void;
  onNew: () => void;
}) {
  const { t, formatDate } = useT();
  return (
    <>
      <p className="text-sm font-medium">{t("support.historyTitle")}</p>
      {history.length === 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">{t("support.historyEmpty")}</p>
      ) : null}
      {history.map((item) => (
          <button
            key={item.conversationId}
            type="button"
            data-support-history-item={item.conversationId}
            onClick={() => onPick(item.conversationId)}
            className="ohb-press flex w-full flex-col gap-1 rounded-2xl border border-border/60 bg-card px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring dark:bg-muted/40"
          >
            <span className="flex w-full items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                {formatDate(item.lastMessageAt ?? item.createdAt)}
              </span>
              {item.status === "closed" ? (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {t("support.historyClosed")}
                </span>
              ) : null}
              {item.unreadCount > 0 ? (
                <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[11px] text-primary-foreground">
                  {item.unreadCount}
                </span>
              ) : null}
            </span>
            <span className="line-clamp-2 text-sm text-foreground">
              {item.lastMessagePreview ?? t("support.historyNoMessage")}
            </span>
          </button>
      ))}
      {/* Un fil neuf se demande ICI, et nulle part ailleurs : c'est le seul
          endroit où l'on voit ce qu'on laisse derrière soi. */}
      <div className="mt-auto pt-2">
        <button type="button" className={cn(BUTTON.secondary, "w-full")} onClick={onNew}>
          {t("support.historyNew")}
        </button>
      </div>
    </>
  );
}

/**
 * La carte « Chat history » du template BoardUI « Chat Starter », à droite
 * de la carte principale : « Nouvelle conversation » en tête, puis les fils
 * récents sur une ligne (aperçu tronqué, âge à droite, point si une réponse
 * du staff attend). Le fil à l'écran est surligné.
 */
export function SupportHistoryCanvas({
  history,
  activeId,
  onPick,
  onNew,
}: {
  history: readonly SupportThreadSummaryDto[];
  activeId: string | null;
  onPick: (conversationId: string) => void;
  onNew: () => void;
}) {
  const { t, locale } = useT();
  return (
    <aside
      aria-label={t("support.historyTitle")}
      data-support-history-canvas=""
      className="ms-4 hidden h-full w-[260px] shrink-0 flex-col gap-6 overflow-hidden rounded-3xl bg-background-secondary-default p-3 xl:flex"
    >
      <button
        type="button"
        onClick={onNew}
        className="flex w-full cursor-pointer items-center gap-2 rounded-2lg px-2 py-2 text-body-medium text-text-primary outline-none transition-colors hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RiAddLine aria-hidden className="size-5 shrink-0 text-foreground-icon-secondary" />
        {t("support.historyNew")}
      </button>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto [scrollbar-width:none]">
        <p className="px-2 pb-1 text-body-2-medium text-text-tertiary">{t("support.historyTitle")}</p>
        {history.length === 0 ? (
          <p className="px-2 text-body-2-regular text-text-tertiary">{t("support.historyEmpty")}</p>
        ) : null}
        {history.map((item) => {
          const active = item.conversationId === activeId;
          const unread = item.unreadCount > 0;
          const closed = item.status === "closed";
          return (
            <button
              key={item.conversationId}
              type="button"
              data-support-history-item={item.conversationId}
              aria-current={active ? "true" : undefined}
              title={closed ? t("support.historyClosed") : undefined}
              onClick={() => {
                if (!active) onPick(item.conversationId);
              }}
              className={cn(
                "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-2lg py-1.5 ps-2 pe-2 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                active ? "bg-background-secondary-hover" : "hover:bg-background-secondary-hover",
              )}
            >
              {unread ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-button-primary" /> : null}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-body-2-regular",
                  unread ? "text-text-primary" : closed ? "text-text-tertiary" : "text-text-secondary",
                )}
              >
                {item.lastMessagePreview ?? t("support.historyNoMessage")}
              </span>
              <span className="shrink-0 text-caption-1-regular text-text-tertiary">
                {ageSince(locale, item.lastMessageAt ?? item.createdAt)}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
