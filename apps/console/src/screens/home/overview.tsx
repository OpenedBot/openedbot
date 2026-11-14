import { Suspense, useEffect, useState, type UIEvent } from "react";
import { Link, lazyRouteComponent } from "@tanstack/react-router";
import { IconPlus } from "@tabler/icons-react";
import { SectionCards } from "../../components/dashboard/section-cards";
import { ChartCardSkeleton, SectionCardsSkeleton } from "../../components/dashboard/overview-skeleton";
import { SiteHeader } from "../../components/dashboard/site-header";
import { ChromeIconButton } from "../../components/mobile/mobile-header";
import { useT } from "../../lib/i18n";
import { cn, useIsMobile } from "@openedbot/browser-ui-kit";
import { SalonOrbit } from "../../components/salon-orbit";
import { NewBotHome } from "./new-bot-home";
import { useBotDialogs } from "../../lib/bots/bot-dialogs";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../../lib/api";

// Recharts with its d3 scales, and the bots table with TanStack Table, are
// their own chunks: the home `/` shares this module with the settings
// overview but draws neither, and loading them held the whole frame, sidebar
// included, behind the route.
const ChartAreaInteractive = lazyRouteComponent(() => import("../../components/dashboard/chart-area-interactive"), "ChartAreaInteractive");
const TokensChart = lazyRouteComponent(() => import("../../components/dashboard/tokens-chart"), "TokensChart");
const BotsTable = lazyRouteComponent(() => import("../../components/dashboard/bots-table"), "BotsTable");

/**
 * Cards, charts and table, the old home, now on the settings
 * overview (`/settings/activity`).
 */
/**
 * `stage`: how many blocks to render, in order (cards, activity, tokens,
 * table). Settings mounts them one by one, one paint between each,
 * rather than in one frame of several hundred milliseconds. A block not
 * yet mounted shows its silhouette (`overview-skeleton.tsx`), at its size.
 */
export function OverviewDashboard({ flush = false, stage = 4 }: { flush?: boolean; stage?: number }) {
  const { t } = useT();
  const loading = t("common.loading");
  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      {stage >= 1 ? <SectionCards flush={flush} /> : <SectionCardsSkeleton label={loading} flush={flush} />}
      <div
        className={cn(
          "grid grid-cols-1 gap-4 md:gap-6 @5xl/main:grid-cols-2",
          !flush && "px-4 lg:px-6",
        )}
      >
        {stage >= 2 ? <Suspense fallback={<ChartCardSkeleton label={loading} />}><ChartAreaInteractive /></Suspense> : <ChartCardSkeleton label={loading} />}
        {stage >= 3 ? <Suspense fallback={<ChartCardSkeleton label={loading} totalLine />}><TokensChart /></Suspense> : <ChartCardSkeleton label={loading} totalLine />}
      </div>
      {stage >= 4 ? <Suspense fallback={null}><BotsTable flush={flush} /></Suspense> : null}
    </div>
  );
}

/**
 * Home `/`. On desktop: creating a bot on the page (`NewBotHome`).
 * On the phone: bloub's paper scene (`#etat=orbit&stop`), not a dashboard.
 * The pebble plays the orbit once then holds. No figure here: the
 * counters live on the settings overview (`/settings/activity`).
 *
 * The page fits in the window: no scrolling on desktop, so no
 * bar. A centered column: a small mascot, the title, the two
 * actions (`overview.css`). Neither explanatory cards nor a watermark: the window
 * is already the product, this is not a welcome page.
 *
 * On the phone, the header is an iOS root-screen navigation bar:
 * menu on the left, title centered, « + » on the right (the « Nouveau bot » sheet),
 * translucent material under which the scene scrolls, and a hairline that
 * appears only once content has passed underneath (`data-scrolled`).
 */

export function OverviewScreen() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const openCreateBot = useBotDialogs((state) => state.openCreate);
  const [scrolled, setScrolled] = useState(false);

  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
  // Only a successful roster proves emptiness; a loading or failed API does not.
  // A workspace with no bot keeps the Salon: one sentence and ONE call, which opens the
  // same sheet as « + ». No form here, it would duplicate it.
  const empty = roster.isSuccess && roster.data.bots.length === 0;
  useSalonReveal(empty);

  // On desktop, the home creates a bot on the page itself (like the reference app's
  // home); the phone keeps the Salon and its « Nouveau bot » sheet.
  if (!isMobile) return <NewBotHome empty={empty} />;

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const next = event.currentTarget.scrollTop > 2;
    if (next !== scrolled) setScrolled(next);
  };

  return (
    <>
      <SiteHeader
        title={t("overviewPlaceholder.nav")}
        root
        // Phone: the scene's `h1` no longer exists, the bar carries it.
        heading={isMobile}
        align="center"
        actions={
          isMobile ? (
            <ChromeIconButton
              label={t("overviewPlaceholder.ctaBot")}
              icon={IconPlus}
              onClick={() => openCreateBot()}
            />
          ) : undefined
        }
      />
      <div
        data-mobile-overview=""
        data-scrolled={scrolled ? "" : undefined}
        onScroll={onScroll}
        className="openedbot-salon flex min-h-0 flex-1 flex-col"
      >
        <div className="openedbot-salon-guide">
          <div className="openedbot-salon-blob" data-reveal="">
            <SalonOrbit />
          </div>
          {/* Phone: the pebble and one sentence, nothing else. The title is
              in the bar, the « + » too; the rest lives in the panel. */}
          {isMobile ? (
            <p className="openedbot-salon-lead" data-reveal="">
              {t(empty ? "overviewPlaceholder.emptyHint" : "overviewPlaceholder.hint")}
            </p>
          ) : (
            <>
              <div className="openedbot-salon-copy" data-reveal="">
                <p className="openedbot-salon-eyebrow">{t("overviewPlaceholder.eyebrow")}</p>
                <h1 className="openedbot-salon-title">{t(empty ? "overviewPlaceholder.emptyTitle" : "overviewPlaceholder.title")}</h1>
                <p className="openedbot-salon-lead">{t(empty ? "overviewPlaceholder.emptyHint" : "overviewPlaceholder.hint")}</p>
              </div>
              <div className="openedbot-salon-actions" data-reveal="">
                {empty ? (
                  <button type="button" className="openedbot-salon-cta" onClick={() => openCreateBot()}>
                    {t("overviewPlaceholder.emptyCta")}
                  </button>
                ) : (
                  <>
                    <Link to="/settings/inbox" className="openedbot-salon-cta">
                      {t("overviewPlaceholder.ctaInbox")}
                    </Link>
                    <button type="button" className="openedbot-salon-ghost" onClick={() => openCreateBot()}>
                      {t("overviewPlaceholder.ctaBot")}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function useSalonReveal(empty: boolean) {
  useEffect(() => {
    const nodes = [...document.querySelectorAll(".openedbot-salon [data-reveal]")];
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const el of nodes) el.classList.add("in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      },
      { threshold: 0.12 },
    );
    for (const el of nodes) io.observe(el);
    const fallback = window.setTimeout(() => {
      for (const el of nodes) el.classList.add("in");
    }, 1200);
    return () => {
      window.clearTimeout(fallback);
      io.disconnect();
    };
  }, [empty]);
}
