import { useQuery } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconMessage,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { Badge, cn } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";
import { DashboardCard, STAT_GRID, StatTile } from "./dashboard-card";
import { SectionCardsSkeleton } from "./overview-skeleton";

/**
 * The four figures of the `dashboard-01` block, with our figures: one
 * settings card (`DESIGN.md` › Bureau › Carte), the title on the tray and the
 * four tiles laid flat in the card, split by hairlines (no frame in the card).
 *
 * The block shows variations (« +12,5 % ce mois »). We do not take them up:
 * it would mean comparing to a previous period we do not compute, and an
 * invented arrow would pass a decoration off as a measurement.
 */
export function SectionCards({ flush = false }: { flush?: boolean }) {
  const { t, formatNumber: number, locale } = useT();
  const overview = useQuery({
    queryKey: queryKeys.overview,
    queryFn: api.overview,
    retry: false,
    refetchInterval: 15_000,
  });

  if (overview.isPending) {
    return <SectionCardsSkeleton label={t("common.loading")} flush={flush} />;
  }

  const hasData = overview.data !== undefined && overview.dataUpdatedAt > 0;
  if (!hasData) {
    return (
      <div className={cn("flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4 text-sm", !flush && "mx-4 lg:mx-6")} role="alert">
        <span>{t("dashboardMetrics.unavailable")}</span>
        <button type="button" className={BUTTON.small} onClick={() => void overview.refetch()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }

  const data = overview.data!;
  const awaiting = data.awaitingApproval;

  return (
    <div className="space-y-2">
      {overview.isError && (
        <div className={cn("flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn-700/40 bg-warn-soft p-3 text-sm text-warn-700", !flush && "mx-4 lg:mx-6")} role="status">
          <span>{t("dashboardMetrics.stale", { date: new Date(overview.dataUpdatedAt).toLocaleString(locale) })}</span>
          <button type="button" className={BUTTON.small} onClick={() => void overview.refetch()}>
            {t("common.retry")}
          </button>
        </div>
      )}
      <DashboardCard
        title={t("sectionCards.title")}
        description={t("sectionCards.description")}
        className={flush ? undefined : "mx-4 lg:mx-6"}
        contentClassName={STAT_GRID}
      >
        <StatTile
          label={t("sectionCards.botsLabel")}
          value={number(data.bots)}
          badge={<Badge variant="outline"><IconMessage />{t("sectionCards.conversationsBadge")}</Badge>}
          footerTitle={t("sectionCards.botsFooterTitle")}
          footerSubtitle={t("sectionCards.botsFooterSubtitle")}
        />
        <StatTile
          label={t("sectionCards.runsLabel")}
          value={number(data.runsTotal)}
          badge={<Badge variant="outline"><IconPlayerPlay />{t("sectionCards.runsRunningBadge", { count: number(data.runsRunning) })}</Badge>}
          footerTitle={t("sectionCards.runsFooterTitle", { completed: number(data.completed), failed: number(data.failed) })}
          footerSubtitle={t("sectionCards.runsFooterSubtitle")}
        />
        <StatTile
          label={t("sectionCards.pendingLabel")}
          value={number(awaiting)}
          // The only tile that calls for a human: it says so with a word,
          // not only with a colour.
          badge={
            <Badge variant={awaiting > 0 ? "destructive" : "outline"}>
              <IconAlertTriangle />
              {awaiting > 0 ? t("sectionCards.pendingBadgeYes") : t("sectionCards.pendingBadgeNo")}
            </Badge>
          }
          footerTitle={awaiting > 0 ? t("sectionCards.pendingFooterTitleYes") : t("sectionCards.pendingFooterTitleNo")}
          footerSubtitle={t("sectionCards.pendingFooterSubtitle")}
        />
        <StatTile
          label={t("sectionCards.successRateLabel")}
          value={data.successRate === null
            ? t("sectionCards.successRateEmpty")
            : t("sectionCards.successRateValue", { rate: data.successRate })}
          badge={<Badge variant="outline"><IconCircleCheck />{t("sectionCards.tokensBadge", { count: number(data.tokens) })}</Badge>}
          footerTitle={data.successRate === null
            ? t("sectionCards.successRateFooterTitleYes")
            : t("sectionCards.successRateFooterTitleNo")}
          footerSubtitle={t("sectionCards.successRateFooterSubtitle")}
        />
      </DashboardCard>
    </div>
  );
}
