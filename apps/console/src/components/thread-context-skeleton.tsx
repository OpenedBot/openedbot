import { Skeleton, SkeletonRegion } from "@openedbot/browser-ui-kit";

/**
 * The detail's silhouette, at the result's geometry: the tab bar, the
 * window card (title, gauge, one line per item), the plan
 * limits, then the card footnotes. Heights close to the real
 * content: nothing jumps when the figures arrive.
 */
export function ThreadContextSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label} className="flex flex-col gap-3" data-thread-context-skeleton="">
      <Skeleton className="h-9 w-full rounded-lg" />
      <div className="flex flex-col gap-3 rounded-2xl bg-card p-4 [--skeleton:var(--muted)] dark:[--skeleton:#404040]">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-1/4" />
        </div>
        <Skeleton className="h-1.5 w-full rounded-full" />
        <div className="flex flex-col gap-2.5 pt-1">
          {SKELETON_ROWS.map((width, index) => (
            <div key={index} className="flex items-center gap-2">
              <Skeleton className="size-2 shrink-0 rounded-full" />
              <Skeleton className="h-3.5" style={{ width }} />
              <Skeleton className="ms-auto h-3.5 w-12" />
              <Skeleton className="h-3.5 w-10" />
            </div>
          ))}
        </div>
        <div className="mt-1 flex flex-col gap-2.5 border-t border-border pt-4">
          <Skeleton className="h-4 w-2/5" />
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-1/5" />
            <Skeleton className="h-3.5 w-1/4" />
          </div>
          <Skeleton className="h-1.5 w-full rounded-full" />
        </div>
      </div>
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
    </SkeletonRegion>
  );
}

/** One width per window line, irregular like the real labels. */
const SKELETON_ROWS = ["42%", "50%", "38%", "34%", "46%", "40%", "24%", "36%", "20%"];
