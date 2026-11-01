import { useEffect, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { IconChevronRight } from "@tabler/icons-react";
import { useT } from "../../../lib/i18n";
import { isOverlaySettingsPath, useSettingsOverlay } from "../../../lib/settings-overlay";
import { OverviewDashboard } from "../../home/overview";
import { SettingsPane } from "../pane";
import { SectionHeading } from "../../../components/settings/primitives";

/**
 * L'accueil des réglages porte les chiffres : cartes, activité, jetons, table
 * des bots. Ils vivaient sous « Modèles », où rien ne les appelait : un écran
 * de choix de modèle n'est pas l'endroit où l'on vient lire une consommation.
 * La Vue d'ensemble, elle, est la première page ouverte en entrant ici.
 *
 * `flush` : les marges viennent de `SettingsPane` (bureau) et du `px-4`
 * ci-dessous (mobile), jamais deux fois.
 */
/** Cartes, activité, jetons, table. */
const DASHBOARD_STAGES = 4;
/**
 * Entre deux graphes Recharts. `0` relance dans la tâche qui vient de peindre
 * et recolle les commits de 100 ms. Une frame laisse le navigateur respirer.
 */
const STAGE_GAP_MS = 32;
/** Le fondu du voile (`animate-in`). Filet si `animationend` ne part pas. */
const MODAL_ENTER_MS = 200;

export function CloudSettingsOverview() {
  const { t } = useT();
  // Les graphes ne montent pas pendant le fondu : un commit Recharts de
  // ~100 ms gelait `fade-in`. On attend la fin de l'animation du voile, puis
  // un bloc par frame peinte. Hors modale (page pleine, test), on démarre
  // tout de suite.
  const [dashboardStage, setDashboardStage] = useState(0);
  useEffect(() => {
    const backdrop = document.querySelector("[data-settings-backdrop]");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!backdrop || reduced) {
      setDashboardStage(1);
      return;
    }
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      setDashboardStage(1);
    };
    const onEnd = (event: Event) => {
      if (event.target === backdrop) start();
    };
    backdrop.addEventListener("animationend", onEnd);
    const fallback = window.setTimeout(start, MODAL_ENTER_MS);
    return () => {
      backdrop.removeEventListener("animationend", onEnd);
      window.clearTimeout(fallback);
    };
  }, []);
  useEffect(() => {
    if (dashboardStage < 1 || dashboardStage >= DASHBOARD_STAGES) return;
    const timer = window.setTimeout(() => setDashboardStage((stage) => stage + 1), STAGE_GAP_MS);
    return () => window.clearTimeout(timer);
  }, [dashboardStage]);
  return (
    <SettingsPane>
      <div className="px-4 md:px-0">
        <OverviewDashboard flush stage={dashboardStage} />
      </div>
      <SectionHeading title="Configuration" description="Connectez les runtimes de votre infrastructure." />
      <div className="grid gap-3 sm:grid-cols-2">
        <SettingsNavCard
          to="/settings/runtime"
          title={t("settingsSidebar.runtime")}
          description="Le runtime de l’organisation, son lien et son remplacement, avec des secrets conservés côté serveur."
        />
        <SettingsNavCard
          to="/settings/agents"
          title="Importer des agents"
          description="Importez les profils Hermes déjà présents sur l’hôte, ou une archive."
        />
        <SettingsNavCard
          to="/settings/account"
          title="Mon compte"
          description="Nom d’utilisateur, membres et quota SaaS."
        />
        <SettingsNavCard
          to="/settings/security"
          title={t("cloudRuntimeSettings.securityNavTitle")}
          description={t("cloudRuntimeSettings.securityNavDescription")}
        />
      </div>
    </SettingsPane>
  );
}

/**
 * Une carte de navigation des réglages : la carte ENTIÈRE est la cible.
 *
 * Le lien souligné posé sous la phrase donnait une cible de la largeur de trois
 * mots dans une carte de 400 px ; tout le reste, titre compris, était mort au
 * clic. On promeut donc la carte en `<Link>` : le survol la teinte, le chevron
 * avance, et il n'y a plus de texte souligné à viser.
 */
function SettingsNavCard({
  to,
  title,
  description,
}: {
  to: string;
  title: string;
  description: string;
}) {
  const overlay = useSettingsOverlay();
  const router = useRouter();
  const className =
    "group flex items-start gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:bg-surface";
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold tracking-tight">{title}</span>
        <span className="mt-1 block max-w-[68ch] text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <IconChevronRight
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </>
  );
  // En surcouche, la carte reste en surcouche (comme la barre de la modale) :
  // un `Link` quitterait la surcouche et remonterait le cadre des réglages.
  if (overlay && isOverlaySettingsPath(to)) {
    return (
      <a
        href={router.buildLocation({ to }).publicHref}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          overlay.open(to);
        }}
        className={className}
      >
        {body}
      </a>
    );
  }
  return (
    <Link to={to} className={className}>
      {body}
    </Link>
  );
}
