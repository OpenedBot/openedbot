import { useId, useState } from "react";
import { Globe } from "lucide-react";
import { cn } from "@openedbot/browser-ui-kit";
import type { WebSearchQuery, WebSearchSource } from "@openedbot/execution/domain/agent-web-search";
import { useT } from "../lib/i18n";

/** How many web results a query lists before « +N autres ». */
const SEARCH_RESULTS_SHOWN = 3;

function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

function SearchSourceRow({ source }: { source: WebSearchSource }) {
  const href = safeHref(source.url);
  const content = (
    <>
      <span aria-hidden className="grid size-5 shrink-0 place-items-center text-text-tertiary">
        <Globe className="size-3.5" />
      </span>
      <span className="min-w-0 truncate font-medium text-text-primary">{source.title || source.domain}</span>
      <span className="min-w-0 shrink-0 truncate text-text-tertiary">{source.domain}</span>
    </>
  );
  const rowClass = "flex min-h-7 min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left";
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={source.url}
      className={cn(rowClass, "outline-none openedbot-row hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring")}
    >
      {content}
    </a>
  ) : (
    <div className={rowClass}>{content}</div>
  );
}

/**
 * What one web search found: the provider's failure, else its first results
 * (title, domain), then « +N autres », a button that lists every other
 * source. Sources come from the run's transcript (`agent-web-search.ts`),
 * never a favicon fetched from a third party: a site glyph is drawn locally.
 */
export function SearchSources({ query, className }: { query: WebSearchQuery; className?: string }) {
  const { t, plural } = useT();
  const [showAll, setShowAll] = useState(false);
  const sourcesId = useId();
  const shown = showAll ? query.sources : query.sources.slice(0, SEARCH_RESULTS_SHOWN);
  const more = query.sources.length - Math.min(query.sources.length, SEARCH_RESULTS_SHOWN);
  return (
    <>
      {query.error ? (
        <p className="ps-8 pe-1.5 text-xs text-destructive-text">{query.error}</p>
      ) : null}
      {shown.length > 0 ? (
        <div id={sourcesId} data-search-sources="" className={cn("space-y-0.5 ps-4", className)}>
          {shown.map((source) => <SearchSourceRow key={source.url} source={source} />)}
          {more > 0 ? (
            <button
              type="button"
              data-search-sources-toggle=""
              aria-expanded={showAll}
              aria-controls={sourcesId}
              onClick={() => setShowAll(!showAll)}
              className="flex min-h-7 items-center rounded-md px-1.5 py-1 ps-8 text-left text-text-tertiary outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none"
            >
              {showAll
                ? t("threadTimeline.activitySearchFewer")
                : plural(more, {
                    one: t("threadTimeline.activitySearchMore_one", { count: more }),
                    other: t("threadTimeline.activitySearchMore_other", { count: more }),
                  })}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
