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
// included, behind the route (ADR 0001, D1b).
const ChartAreaInteractive = lazyRouteComponent(() => import("../../components/dashboard/chart-area-interactive"), "ChartAreaInteractive");
const TokensChart = lazyRouteComponent(() => import("../../components/dashboard/tokens-chart"), "TokensChart");
const BotsTable = lazyRouteComponent(() => import("../../components/dashboard/bots-table"), "BotsTable");

/**
 * Cartes, graphiques et table, l’ancien accueil, désormais sur la Vue
 * d’ensemble des réglages (`/settings`).
 */
/**
 * `stage` : combien de blocs rendre, dans l'ordre (cartes, activité, jetons,
 * table). Les réglages les montent un par un, une peinture entre chaque,
 * plutôt qu'en une frame de plusieurs centaines de millisecondes. Un bloc pas
 * encore monté montre sa silhouette (`overview-skeleton.tsx`), à sa taille.
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
 * Foyer `/`. Au bureau : la création d'un bot sur la page (`NewBotHome`).
 * Sur téléphone : la scène papier de bloub (`#etat=orbit&stop`), pas un dashboard.
 * Le galet joue l'orbite une fois puis tient. Aucun chiffre ici : les
 * compteurs vivent sur la Vue d'ensemble des réglages (`/settings`).
 *
 * La page tient dans la fenêtre : pas de défilement au bureau, donc pas de
 * barre. Une colonne centrée : une petite mascotte, le titre, les deux
 * actions (`overview.css`). Ni cartes explicatives ni filigrane : la fenêtre
 * est déjà le produit, ce n'est pas une page d'accueil.
 *
 * Sur téléphone, l'en-tête est une barre de navigation iOS d'écran racine :
 * menu à gauche, titre centré, « + » à droite (la feuille « Nouveau bot »),
 * matériau translucide sous lequel la scène défile, et un filet qui
 * n'apparaît qu'une fois du contenu passé dessous (`data-scrolled`).
 */

export function OverviewScreen() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const openCreateBot = useBotDialogs((state) => state.openCreate);
  const [scrolled, setScrolled] = useState(false);

  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
  // Only a successful roster proves emptiness; a loading or failed API does not.
  // Un espace sans bot garde le salon : une phrase et UN appel, qui ouvre la
  // même feuille que « + ». Pas de formulaire ici, il ferait doublon avec elle.
  const empty = roster.isSuccess && roster.data.bots.length === 0;
  useSalonReveal(empty);

  // Au bureau, l'accueil crée un bot sur la page même (comme l'accueil
  // d'OpenBot) ; le téléphone garde le salon et sa feuille « Nouveau bot ».
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
        // Téléphone : le `h1` de la scène n'existe plus, la barre le porte.
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
          {/* Téléphone : le galet et une phrase, rien d'autre. Le titre est
              dans la barre, le « + » aussi ; le reste vit dans le panneau. */}
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
                    <Link to="/inbox" className="openedbot-salon-cta">
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
