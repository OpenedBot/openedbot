import { Badge, Skeleton, cn } from "@openedbot/browser-ui-kit";
import { DashboardCard, STAT_GRID, StatTile } from "./dashboard-card";

/**
 * Activity's silhouettes (`/settings/activity`), outside the charts chunk: the
 * section's fallback (`settings-skeletons.tsx`), the frame during the guards
 * (`AppFrameSkeleton`) and the blocks of `OverviewDashboard` not yet mounted
 * draw the same thing, so nothing shifts from one step to the next.
 *
 * Each silhouette reuses the real card's components (`DashboardCard`,
 * `StatTile`, `Badge`…) and places the bars in text lines of the
 * same class: the height comes from the same `line-height` and the same
 * margins, instead of a height fixed by hand that drifted by 12 px (a
 * tile was 128 px while loading, 140 px loaded) and followed the text
 * size poorly.
 */

/**
 * On a card, the bars' grey steps up one notch (the convention of
 * `skeleton.tsx`): in dark mode, `--muted` equals the `bg-card` background and the
 * bars disappeared.
 */
const ON_CARD = "[--skeleton:var(--muted)] dark:[--skeleton:#404040]";

/** A bar that pulses inside a text line, without changing its height. */
function TextBar({ className }: { className: string }) {
  return <Skeleton className={cn("inline-block align-middle motion-reduce:animate-none", className)} />;
}

export function SectionCardsSkeleton({ label, flush }: { label: string; flush?: boolean }) {
  return (
    <div className="space-y-2">
      <DashboardCard
        role="status"
        aria-label={label}
        title={<TitleBar />}
        description={<DescriptionBar className="w-72" />}
        className={flush ? undefined : "mx-4 lg:mx-6"}
        contentClassName={cn(STAT_GRID, ON_CARD)}
      >
        {[0, 1, 2, 3].map((index) => (
          <StatTile
            key={index}
            label={<TextBar className="h-3 w-24" />}
            value={<TextBar className="h-6 w-12" />}
            badge={<Badge variant="outline"><TextBar className="h-3 w-16" /></Badge>}
            footerTitle={<TextBar className="h-3 w-40" />}
            footerSubtitle={<TextBar className="h-3 w-28" />}
          />
        ))}
      </DashboardCard>
    </div>
  );
}

/** A card title's bar, at the height of its line (`CARD_TITLE`, 20 px). */
function TitleBar() {
  return <span className="flex h-5 items-center"><Skeleton className="h-3.5 w-32 motion-reduce:animate-none" /></span>;
}

/** A line of the sentence under the title (20 px). */
function DescriptionBar({ className }: { className: string }) {
  return <span className="flex h-5 items-center"><Skeleton className={cn("h-3 motion-reduce:animate-none", className)} /></span>;
}

/** The plot's margins in its card, shared by both charts and their silhouette. */
export const CHART_CONTENT = "px-2 py-4 sm:px-4";

/**
 * The plot at its final height (250 px) and the tick row: the
 * content of a chart card while its data arrives.
 */
export function ChartPlotSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className={cn("flex h-[250px] w-full flex-col gap-2", ON_CARD)}>
      <Skeleton className="min-h-0 w-full flex-1 motion-reduce:animate-none" />
      <div className="flex justify-between px-2">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <Skeleton key={index} className="h-3 w-10 motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}

/**
 * A whole chart card (activity or tokens) before its module is
 * mounted: title, description, period selector and plot. `totalLine`:
 * the tokens card carries a total line under its description.
 */
export function ChartCardSkeleton({ label, totalLine = false }: { label: string; totalLine?: boolean }) {
  return (
    <DashboardCard
      title={<TitleBar />}
      description={
        <>
          <DescriptionBar className="w-56" />
          {totalLine ? <DescriptionBar className="w-40" /> : null}
        </>
      }
      action={
        <>
          <Skeleton className="hidden h-9 w-72 rounded-md motion-reduce:animate-none @[767px]/card:block" />
          <Skeleton className="h-9 w-40 rounded-md motion-reduce:animate-none @[767px]/card:hidden" />
        </>
      }
      contentClassName={CHART_CONTENT}
    >
      <ChartPlotSkeleton label={label} />
    </DashboardCard>
  );
}

/** The top of Activity: tiles then the two charts, like `OverviewDashboard` (`flush`). */
export function OverviewDashboardSkeleton({ label }: { label: string }) {
  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <SectionCardsSkeleton label={label} flush />
      <div className="grid grid-cols-1 gap-4 md:gap-6 @5xl/main:grid-cols-2">
        <ChartCardSkeleton label={label} />
        <ChartCardSkeleton label={label} totalLine />
      </div>
    </div>
  );
}
