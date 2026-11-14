import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import {
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
import { CHART_CONTENT, ChartPlotSkeleton } from "./overview-skeleton";
import { DashboardCard } from "./dashboard-card";
import type { UsagePoint } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";

/**
 * Token consumption over time, in calendar buckets.
 *
 * Two stacked series, input and output tokens, with distinct
 * colours AND a written legend, for the same accessibility reason as the
 * activity chart. `--chart-2`/`--chart-5` are already given the meaning
 * success/failure on this page: other tints are taken so as not to
 * suggest a false parallel.
 */
type Granularity = "day" | "week" | "month" | "year";

/** Tick and tooltip formats specific to each granularity. */
const FORMATS: Record<Granularity, { tick: Intl.DateTimeFormatOptions; tooltip: Intl.DateTimeFormatOptions }> = {
  day: { tick: { month: "short", day: "numeric" }, tooltip: { month: "long", day: "numeric" } },
  week: { tick: { month: "short", day: "numeric" }, tooltip: { month: "long", day: "numeric" } },
  month: { tick: { month: "short", year: "2-digit" }, tooltip: { month: "long", year: "numeric" } },
  year: { tick: { year: "numeric" }, tooltip: { year: "numeric" } },
};

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

  // 90 daily ticks are unreadable on a small screen; 24 monthly
  // points fit, by the same logic as the activity chart's forced 7 days.
  useEffect(() => {
    if (isMobile) setGranularity("month");
  }, [isMobile]);

  // Unlike the overview, usage does not need a freshness of 15 s:
  // a minute is enough for a consumption history.
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
    <DashboardCard
      title={t("chartTokens.title")}
      description={
        <>
          <span className="hidden @[540px]/card:block">{t("chartTokens.descriptionFull")}</span>
          <span className="@[540px]/card:hidden">{t("chartTokens.descriptionShort")}</span>
          {/* The total line keeps its place while loading: without
              it the card grew by 20 px when the figures arrived. */}
          <span className="block text-foreground">
            {usage.isPending
              ? <span className="flex h-5 items-center"><Skeleton className="h-3.5 w-40 motion-reduce:animate-none" /></span>
              : hasData && t("chartTokens.totalForPeriod", { count: formatNumber(periodTotal) })}
          </span>
        </>
      }
      action={
        <>
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
        </>
      }
      contentClassName={CHART_CONTENT}
    >
        {usage.isPending ? (
          <ChartPlotSkeleton label={t("common.loading")} />
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
          // A chart flat at zero reads as an outage. Saying so is more
          // honest than drawing a null consumption.
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
              {/* `monotone` and not `natural`: the natural spline dips below
                  zero when a long flat series is followed by a spike, and a
                  negative consumption does not exist. Monotone interpolation
                  stays bounded by the points. */}
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
    </DashboardCard>
  );
}
