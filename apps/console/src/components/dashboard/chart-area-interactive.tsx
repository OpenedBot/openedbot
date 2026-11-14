import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import type { ActivityPoint } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";

/**
 * The `dashboard-01` block's chart, wired to real activity.
 *
 * Two series rather than the block's `desktop`/`mobile`: successes and failures.
 * They have distinct colours and a written legend. A stack of
 * two areas that differ only by tint is not readable for
 * everyone.
 */
const RANGE_VALUES = [
  { value: "90d", days: 90 },
  { value: "30d", days: 30 },
  { value: "7d", days: 7 },
] as const;

export function ChartAreaInteractive() {
  const { t, formatDate, locale } = useT();
  const chartConfig = {
    completed: { label: t("chartArea.seriesCompleted"), color: "var(--chart-2)" },
    failed: { label: t("chartArea.seriesFailed"), color: "var(--chart-5)" },
  } satisfies ChartConfig;
  const RANGES = [
    { ...RANGE_VALUES[0], label: t("chartArea.range90d") },
    { ...RANGE_VALUES[1], label: t("chartArea.range30d") },
    { ...RANGE_VALUES[2], label: t("chartArea.range7d") },
  ];
  const isMobile = useIsMobile();
  const [timeRange, setTimeRange] = useState<string>("90d");

  useEffect(() => {
    if (isMobile) setTimeRange("7d");
  }, [isMobile]);

  const overview = useQuery({
    queryKey: queryKeys.overview,
    queryFn: api.overview,
    retry: false,
    refetchInterval: 15_000,
  });

  const hasData = overview.data !== undefined && overview.dataUpdatedAt > 0;
  const days = RANGES.find((range) => range.value === timeRange)?.days ?? 90;
  // The server already returns the full window, empty days included: filtering
  // by the end is enough, and the chart keeps a continuous x-axis.
  const data = (hasData ? overview.data!.activity : []).slice(-days);
  const hasActivity = data.some((point: ActivityPoint) => point.completed + point.failed > 0);

  return (
    <DashboardCard
      title={t("chartArea.title")}
      description={
        <>
          <span className="hidden @[540px]/card:block">{t("chartArea.descriptionFull")}</span>
          <span className="@[540px]/card:hidden">{t("chartArea.descriptionShort")}</span>
        </>
      }
      action={
        <>
          <ToggleGroup
            type="single"
            value={timeRange}
            onValueChange={(value) => value && setTimeRange(value)}
            variant="outline"
            className="hidden *:data-[slot=toggle-group-item]:px-4! @[767px]/card:flex"
          >
            {RANGES.map((range) => (
              <ToggleGroupItem key={range.value} value={range.value}>
                {range.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger
              className="flex w-40 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[767px]/card:hidden"
              size="sm"
              aria-label={t("chartArea.periodAriaLabel")}
            >
              <SelectValue placeholder={t("chartArea.range90d")} />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              {RANGES.map((range) => (
                <SelectItem key={range.value} value={range.value} className="rounded-lg">
                  {range.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      }
      contentClassName={CHART_CONTENT}
    >
        {overview.isPending ? (
          <ChartPlotSkeleton label={t("common.loading")} />
        ) : !hasData ? (
          <div className="flex min-h-40 flex-wrap items-center justify-center gap-3 text-sm" role="alert">
            <span>{t("dashboardMetrics.unavailable")}</span>
            <button type="button" className={BUTTON.small} onClick={() => void overview.refetch()}>
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {overview.isError && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn-700/40 bg-warn-soft p-3 text-sm text-warn-700" role="status">
                <span>{t("dashboardMetrics.stale", { date: new Date(overview.dataUpdatedAt).toLocaleString(locale) })}</span>
                <button type="button" className={BUTTON.small} onClick={() => void overview.refetch()}>
                  {t("common.retry")}
                </button>
              </div>
            )}
            {!hasActivity ? (
          // A chart flat at zero reads as an outage. Saying so is more
          // honest than drawing a line of null activity.
          <div className="flex h-[250px] flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
            <span>{t("chartArea.emptyTitle")}</span>
            <span className="text-xs">{t("chartArea.emptySubtitle")}</span>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[250px] w-full">
            <AreaChart data={data}>
              <defs>
                <linearGradient id="fillCompleted" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-completed)" stopOpacity={1.0} />
                  <stop offset="95%" stopColor="var(--color-completed)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fillFailed" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-failed)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-failed)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(value: string) =>
                  formatDate(value, { month: "short", day: "numeric" })
                }
              />
              <ChartTooltip
                cursor={false}
                defaultIndex={isMobile ? -1 : undefined}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) =>
                      formatDate(value as string, { month: "long", day: "numeric" })
                    }
                    indicator="dot"
                  />
                }
              />
              {/* `monotone` and not `natural`: the natural spline dips below
                  zero when a long flat series is followed by a spike, and a
                  negative run does not exist. Monotone interpolation stays
                  bounded by the points. */}
              <Area
                dataKey="failed"
                type="monotone"
                fill="url(#fillFailed)"
                stroke="var(--color-failed)"
                stackId="a"
              />
              <Area
                dataKey="completed"
                type="monotone"
                fill="url(#fillCompleted)"
                stroke="var(--color-completed)"
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
