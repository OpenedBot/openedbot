import { useQuery } from "@tanstack/react-query";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconMessage,
  IconPlayerPlay,
} from "@tabler/icons-react";
import {
  Badge,
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cn,
} from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";
import { SectionCardsSkeleton } from "./overview-skeleton";

/**
 * Les quatre cartes du bloc `dashboard-01`, avec nos chiffres.
 *
 * Le bloc affiche des variations (« +12,5 % ce mois »). On ne les reprend pas :
 * il faudrait comparer à une période précédente qu'on ne calcule pas, et une
 * flèche inventée ferait passer une décoration pour une mesure.
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
      <div
        className={cn(
          "grid grid-cols-1 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card",
          !flush && "px-4 lg:px-6",
        )}
      >
      <Card className="@container/card [--card-spacing:--spacing(4)]">
        <CardHeader>
          <CardDescription className="text-xs">{t("sectionCards.botsLabel")}</CardDescription>
          <CardTitle className="text-xl font-semibold tabular-nums @[250px]/card:text-2xl">
            {number(data.bots)}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <IconMessage />
              {t("sectionCards.conversationsBadge")}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-0.5 text-xs">
          <div className="line-clamp-1 font-medium">{t("sectionCards.botsFooterTitle")}</div>
          <div className="text-muted-foreground">{t("sectionCards.botsFooterSubtitle")}</div>
        </CardFooter>
      </Card>

      <Card className="@container/card [--card-spacing:--spacing(4)]">
        <CardHeader>
          <CardDescription className="text-xs">{t("sectionCards.runsLabel")}</CardDescription>
          <CardTitle className="text-xl font-semibold tabular-nums @[250px]/card:text-2xl">
            {number(data.runsTotal)}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <IconPlayerPlay />
              {t("sectionCards.runsRunningBadge", { count: number(data.runsRunning) })}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-0.5 text-xs">
          <div className="line-clamp-1 font-medium">
            {t("sectionCards.runsFooterTitle", {
              completed: number(data.completed),
              failed: number(data.failed),
            })}
          </div>
          <div className="text-muted-foreground">{t("sectionCards.runsFooterSubtitle")}</div>
        </CardFooter>
      </Card>

      <Card className="@container/card [--card-spacing:--spacing(4)]">
        <CardHeader>
          <CardDescription className="text-xs">{t("sectionCards.pendingLabel")}</CardDescription>
          <CardTitle className="text-xl font-semibold tabular-nums @[250px]/card:text-2xl">
            {number(awaiting)}
          </CardTitle>
          <CardAction>
            {/* La seule carte qui réclame un humain : elle le dit par un mot,
                pas seulement par une couleur. */}
            <Badge variant={awaiting > 0 ? "destructive" : "outline"}>
              <IconAlertTriangle />
              {awaiting > 0 ? t("sectionCards.pendingBadgeYes") : t("sectionCards.pendingBadgeNo")}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-0.5 text-xs">
          <div className="line-clamp-1 font-medium">
            {awaiting > 0
              ? t("sectionCards.pendingFooterTitleYes")
              : t("sectionCards.pendingFooterTitleNo")}
          </div>
          <div className="text-muted-foreground">{t("sectionCards.pendingFooterSubtitle")}</div>
        </CardFooter>
      </Card>

      <Card className="@container/card [--card-spacing:--spacing(4)]">
        <CardHeader>
          <CardDescription className="text-xs">{t("sectionCards.successRateLabel")}</CardDescription>
          <CardTitle className="text-xl font-semibold tabular-nums @[250px]/card:text-2xl">
            {data.successRate === null
              ? t("sectionCards.successRateEmpty")
              : t("sectionCards.successRateValue", { rate: data.successRate })}
          </CardTitle>
          <CardAction className="flex flex-wrap justify-end gap-1">
            <Badge variant="outline">
              <IconCircleCheck />
              {t("sectionCards.tokensBadge", { count: number(data.tokens) })}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-0.5 text-xs">
          <div className="line-clamp-1 font-medium">
            {data.successRate === null
              ? t("sectionCards.successRateFooterTitleYes")
              : t("sectionCards.successRateFooterTitleNo")}
          </div>
          <div className="text-muted-foreground">{t("sectionCards.successRateFooterSubtitle")}</div>
        </CardFooter>
      </Card>
      </div>
    </div>
  );
}
