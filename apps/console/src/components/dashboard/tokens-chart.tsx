import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  ToggleGroup,
  ToggleGroupItem,
  useIsMobile,
} from "@openedbot/browser-ui-kit";
// Charts live in their own entry: recharts must not load with the barrel.
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@openedbot/browser-ui-kit/components/ui/chart";
import type { UsagePoint } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";

/**
 * La consommation de jetons dans le temps, en buckets calendaires.
 *
 * Deux séries empilées, jetons d'entrée et de sortie, avec des couleurs
 * distinctes ET une légende écrite, pour la même raison d'accessibilité que le
 * graphique d'activité. `--chart-2`/`--chart-5` sont déjà sémantisées
 * réussite/échec sur cette page : on prend d'autres teintes pour ne pas
 * suggérer un faux parallèle.
 */
type Granularity = "day" | "week" | "month" | "year";

/** Formats de graduation et d'infobulle propres à chaque granularité. */
const FORMATS: Record<Granularity, { tick: Intl.DateTimeFormatOptions; tooltip: Intl.DateTimeFormatOptions }> = {
  day: { tick: { month: "short", day: "numeric" }, tooltip: { month: "long", day: "numeric" } },
  week: { tick: { month: "short", day: "numeric" }, tooltip: { month: "long", day: "numeric" } },
  month: { tick: { month: "short", year: "2-digit" }, tooltip: { month: "long", year: "numeric" } },
  year: { tick: { year: "numeric" }, tooltip: { year: "numeric" } },
};

/** Même silhouette de chargement que le graphique d'activité. */
function TokensChartSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex h-[250px] w-full flex-col gap-2">
      <Skeleton className="min-h-0 w-full flex-1 motion-reduce:animate-none" />
      <div className="flex justify-between px-2">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <Skeleton key={index} className="h-3 w-10 motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}

export function TokensChart() {
  const { t, formatDate, formatNumber, locale } = useT();
  const chartConfig = {
    inputTokens: { label: t("chartTokens.seriesInput"), color: "var(--chart-1)" },
    outputTokens: { label: t("chartTokens.seriesOutput"), color: "var(--chart-3)" },
  } satisfies ChartConfig;
  const GRANULARITIES = [
    { value: "day", label: t("chartTokens.granularityDay") },
    { value: "week", label: t("chartTokens.granularityWeek") },
    { value: "month", label: t("chartTokens.granularityMonth") },
    { value: "year", label: t("chartTokens.granularityYear") },
  ] as const;
  const isMobile = useIsMobile();
  const [granularity, setGranularity] = useState<Granularity>("day");

  // 90 graduations quotidiennes sont illisibles sur petit écran ; 24 points
  // mensuels passent, selon la même logique que le 7 jours forcé du graphe d'activité.
  useEffect(() => {
    if (isMobile) setGranularity("month");
  }, [isMobile]);

  // Contrairement à l'overview, l'usage n'a pas besoin d'une fraîcheur de 15 s :
  // une minute suffit pour un historique de consommation.
  const usage = useQuery({
    queryKey: queryKeys.usage,
    queryFn: api.usage,
    retry: false,
    refetchInterval: 60_000,
  });

  const hasData = usage.data !== undefined && usage.dataUpdatedAt > 0;
  const data = hasData ? usage.data![granularity] : [];
  const hasUsage = data.some((point: UsagePoint) => point.totalTokens > 0);
  const periodTotal = data.reduce((sum: number, point: UsagePoint) => sum + point.totalTokens, 0);
  const formats = FORMATS[granularity];
  const tooltipLabel = (value: string) =>
    granularity === "week"
      ? t("chartTokens.weekOf", { date: formatDate(value, formats.tooltip) })
      : formatDate(value, formats.tooltip);

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>{t("chartTokens.title")}</CardTitle>
        <CardDescription>
          <span className="hidden @[540px]/card:block">{t("chartTokens.descriptionFull")}</span>
          <span className="@[540px]/card:hidden">{t("chartTokens.descriptionShort")}</span>
          <span className="block text-foreground">
            {hasData && t("chartTokens.totalForPeriod", { count: formatNumber(periodTotal) })}
          </span>
        </CardDescription>
        <CardAction>
          <ToggleGroup
            type="single"
            value={granularity}
            onValueChange={(value) => value && setGranularity(value as Granularity)}
            variant="outline"
            className="hidden *:data-[slot=toggle-group-item]:px-4! @[767px]/card:flex"
          >
            {GRANULARITIES.map((item) => (
              <ToggleGroupItem key={item.value} value={item.value}>
                {item.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Select value={granularity} onValueChange={(value) => setGranularity(value as Granularity)}>
            <SelectTrigger
              className="flex w-40 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[767px]/card:hidden"
              size="sm"
              aria-label={t("chartTokens.granularityAriaLabel")}
            >
              <SelectValue placeholder={t("chartTokens.granularityDay")} />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              {GRANULARITIES.map((item) => (
                <SelectItem key={item.value} value={item.value} className="rounded-lg">
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>

      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {usage.isPending ? (
          <TokensChartSkeleton label={t("common.loading")} />
        ) : !hasData ? (
          <div className="flex min-h-40 flex-wrap items-center justify-center gap-3 text-sm" role="alert">
            <span>{t("dashboardMetrics.unavailable")}</span>
            <button type="button" className={BUTTON.small} onClick={() => void usage.refetch()}>
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {usage.isError && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn-700/40 bg-warn-soft p-3 text-sm text-warn-700" role="status">
                <span>{t("dashboardMetrics.stale", { date: new Date(usage.dataUpdatedAt).toLocaleString(locale) })}</span>
                <button type="button" className={BUTTON.small} onClick={() => void usage.refetch()}>
                  {t("common.retry")}
                </button>
              </div>
            )}
            {!hasUsage ? (
          // Un graphique plat à zéro se lit comme une panne. Le dire est plus
          // honnête que de tracer une consommation nulle.
          <div className="flex h-[250px] flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
            <span>{t("chartTokens.emptyTitle")}</span>
            <span className="text-xs">{t("chartTokens.emptySubtitle")}</span>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[250px] w-full">
            <AreaChart data={data}>
              <defs>
                <linearGradient id="fillInputTokens" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-inputTokens)" stopOpacity={1.0} />
                  <stop offset="95%" stopColor="var(--color-inputTokens)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fillOutputTokens" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-outputTokens)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-outputTokens)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(value: string) => formatDate(value, formats.tick)}
              />
              <ChartTooltip
                cursor={false}
                defaultIndex={isMobile ? -1 : undefined}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => tooltipLabel(value as string)}
                    indicator="dot"
                  />
                }
              />
              {/* `monotone` et pas `natural` : la spline naturelle dépasse sous
                  zéro quand une longue série plate est suivie d'un pic, et une
                  consommation négative n'existe pas. L'interpolation monotone
                  reste bornée par les points. */}
              <Area
                dataKey="outputTokens"
                type="monotone"
                fill="url(#fillOutputTokens)"
                stroke="var(--color-outputTokens)"
                stackId="a"
              />
              <Area
                dataKey="inputTokens"
                type="monotone"
                fill="url(#fillInputTokens)"
                stroke="var(--color-inputTokens)"
                stackId="a"
              />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
