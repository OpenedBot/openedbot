import { cn } from "@openedbot/browser-ui-kit";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";

/**
 * Class constants of the table card: ONE card (`bg-card`, white in light,
 * #262626 in dark) carrying the title row, the content under a hairline
 * (`body`) with a column band and flat rows separated by a hairline, and the
 * footer, as the settings cards (`SETTINGS_SHELL`). Spread them on native
 * elements like `BUTTON`.
 */
export const DATA_TABLE = {
  card: "min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm",
  header: "flex flex-wrap items-center justify-between gap-3 px-4 pt-3.5 pb-3",
  body: "min-w-0 overflow-hidden border-t border-border/60",
  tabs: "mx-3 my-2 max-w-[calc(100%-1.5rem)] self-start overflow-x-auto overflow-y-hidden",
  headRow: "h-[46px] border-b border-border-table bg-background-secondary-default text-left text-sm font-medium text-text-tertiary dark:bg-white/5",
  headCell: "py-2 pl-3 pr-3 font-medium",
  bodyRows: "[&>tr]:border-b [&>tr]:border-border-table [&>tr:last-child]:border-b-0",
  row: "h-[59px] align-middle",
  cell: "py-3 pl-3 pr-3",
  list: "[&>li]:border-b [&>li]:border-border-table [&>li:last-child]:border-b-0",
  listRow: "flex min-h-[59px] flex-wrap items-center justify-between gap-3 py-2 pl-3 pr-3",
  empty: "px-4 py-8 text-center text-sm text-text-tertiary",
  footer: "flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-4 py-2.5",
} as const;

/** Rows a dashboard table shows at once before paginating. */
export const DATA_TABLE_PAGE_SIZE = 5;

/** Page indexes to render (0-based), with `null` for a gap: all of them up to 7, else first, neighbours, last. */
export function pageWindow(page: number, pages: number): Array<number | null> {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index);
  const from = Math.max(1, Math.min(page - 1, pages - 4));
  const to = Math.min(pages - 2, Math.max(page + 1, 3));
  return [0, ...(from > 1 ? [null] : []), ...Array.from({ length: to - from + 1 }, (_, index) => from + index), ...(to < pages - 2 ? [null] : []), pages - 1];
}

const PAGE_BUTTON = "inline-flex size-8 items-center justify-center rounded-lg text-sm tabular-nums text-text-secondary outline-none transition-colors hover:bg-background-secondary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

/**
 * `< 1 2 3 >` pager of the template. Previous and next may reach past the
 * numbered pages (a server page beyond), hence the optional overrides.
 */
export function DataTablePagination({ page, pages, onPage, label, previousLabel, nextLabel, pageLabel, canPrevious = page > 0, canNext = page < pages - 1, onPrevious, onNext }: {
  page: number; pages: number; onPage: (page: number) => void; label: string; previousLabel: string; nextLabel: string;
  pageLabel: (page: number) => string; canPrevious?: boolean; canNext?: boolean; onPrevious?: () => void; onNext?: () => void;
}) {
  return <nav aria-label={label} className="flex items-center gap-1">
    <button type="button" className={PAGE_BUTTON} aria-label={previousLabel} disabled={!canPrevious} onClick={onPrevious ?? (() => onPage(page - 1))}>
      <IconChevronLeft className="size-4" aria-hidden />
    </button>
    {pageWindow(page, pages).map((index, position) => index === null
      ? <span key={`gap-${position}`} className="px-1 text-sm text-text-tertiary" aria-hidden>...</span>
      : <button key={index} type="button" aria-label={pageLabel(index)} aria-current={index === page ? "page" : undefined} onClick={() => onPage(index)}
        className={cn(PAGE_BUTTON, index === page && "border border-border-button-default bg-background-full font-medium text-text-primary shadow-xs")}>{index + 1}</button>)}
    <button type="button" className={PAGE_BUTTON} aria-label={nextLabel} disabled={!canNext} onClick={onNext ?? (() => onPage(page + 1))}>
      <IconChevronRight className="size-4" aria-hidden />
    </button>
  </nav>;
}
