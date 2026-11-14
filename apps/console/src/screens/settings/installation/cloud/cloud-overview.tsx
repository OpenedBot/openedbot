import { useEffect, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { IconChevronRight } from "@tabler/icons-react";
import { useT } from "../../../../lib/i18n";
import { isOverlaySettingsPath, useSettingsOverlay } from "../../../../lib/shell/settings-overlay";
import { OverviewDashboard } from "../../../home/overview";
import { SettingsPane } from "../../pane";
import { ListSection } from "../../../../components/settings/primitives";

/**
 * The settings home carries the figures: cards, activity, tokens, the bot
 * table. They used to live under « Modèles », where nothing called for them: a
 * model-choice screen is not where one comes to read a consumption.
 * The overview is the first page opened on entering here.
 *
 * `flush`: the margins come from `SettingsPane` (desktop) and from the `px-4`
 * below (mobile), never twice.
 */
/** Cards, activity, tokens, table. */
const DASHBOARD_STAGES = 4;
/**
 * Between two Recharts graphs. `0` restarts inside the task that just painted
 * and sticks the 100 ms commits back together. One frame lets the browser breathe.
 */
const STAGE_GAP_MS = 32;

export function CloudSettingsOverview() {
  const { t } = useT();
  // One block per painted frame: one Recharts commit of ~100 ms per graph
  // froze the page when they all mounted together.
  const [dashboardStage, setDashboardStage] = useState(1);
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
      <ListSection title="Configuration" description="Connectez les runtimes de votre infrastructure.">
        <SettingsNavRow
          to="/settings/runtime"
          title={t("settingsSidebar.runtime")}
          description="Le runtime de l’organisation, son lien et son remplacement, avec des secrets conservés côté serveur."
        />
        <SettingsNavRow
          to="/settings/agents"
          title="Importer des agents"
          description="Importez les profils Hermes déjà présents sur l’hôte, ou une archive."
        />
        <SettingsNavRow
          to="/settings/account"
          title="Mon compte"
          description="Nom d’utilisateur, membres et quota SaaS."
        />
        <SettingsNavRow
          to="/settings/security"
          title={t("cloudRuntimeSettings.securityNavTitle")}
          description={t("cloudRuntimeSettings.securityNavDescription")}
        />
      </ListSection>
    </SettingsPane>
  );
}

/**
 * A row of the « Configuration » list that leads to a section: the WHOLE row
 * is the target, as the cards it replaces were (an underlined link under the
 * sentence gave a target three words wide). The row keeps `ListRow`'s
 * geometry, label and sentence on the left, the chevron on the right; hover
 * tints it and the chevron moves forward.
 */
function SettingsNavRow({
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
    "group flex min-h-14 items-center gap-4 px-4 py-3 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block max-w-[68ch] text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <IconChevronRight
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </>
  );
  // In the overlay, the row stays in the overlay (like the modal's bar):
  // a `Link` would leave the overlay and bring the settings frame back up.
  if (overlay && isOverlaySettingsPath(to)) {
    return (
      <li data-settings-row="">
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
      </li>
    );
  }
  return (
    <li data-settings-row="">
      <Link to={to} className={className}>
        {body}
      </Link>
    </li>
  );
}
