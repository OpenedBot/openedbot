import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RiServerLine } from "@remixicon/react";
import { cn } from "@openedbot/browser-ui-kit";
import { runtimeQueryOptions } from "../../lib/api";
import { connectorUpgradeLevel, hermesUpdate } from "../../lib/runtime/connector-upgrade";
import { useT } from "../../lib/i18n";

/** The warning dot, same token as the runtime health pastille's `warning` tone. */
const WARN_DOT = "rounded-full bg-warn-700 ring-2 ring-background";
/** A release that is merely available: the same dot, in the information tone. */
const INFO_DOT = "rounded-full bg-info-700 ring-2 ring-background";

/**
 * The upgrade level of the active runtime's connector, and a newer Hermes
 * shipped with the latest edge-setup. Same query key as the health pastille
 * and the account card: no extra request.
 */
function useConnectorUpgrade() {
  const runtime = useQuery(runtimeQueryOptions());
  return { level: connectorUpgradeLevel(runtime.data?.link?.connector), hermes: hermesUpdate(runtime.data?.link) };
}

/**
 * Pinned next to the runtime health pastille: one warning dot that opens the
 * runtime screen, where the upgrade command waits.
 */
export function ConnectorUpgradeDot() {
  const { t } = useT();
  const label = t("connectorUpgrade.badgeAria");
  return (
    <Link
      to="/settings/runtime"
      search={{ section: "status" }}
      data-connector-upgrade=""
      aria-label={label}
      title={label}
      className="flex h-11 shrink-0 items-center px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span aria-hidden className={cn("size-2.5", WARN_DOT)} />
    </Link>
  );
}

/**
 * Sidebar footer entry while the connector is behind: outdated (warning) or
 * a newer edge-setup release available (information). Otherwise, a newer
 * Hermes that the latest edge-setup installs (information, same entry). The
 * desktop header carries no runtime pastille, so the sidebar says it there;
 * on mobile the same footer sits in the drawer.
 */
export function ConnectorUpgradeSidebarLink({ className, onNavigate }: { className: string; onNavigate?: () => void }) {
  const { t } = useT();
  const { level, hermes } = useConnectorUpgrade();
  if (!level && !hermes) return null;
  const outdated = level === "outdated";
  const label = level
    ? t(outdated ? "connectorUpgrade.badge" : "connectorUpgrade.badgeAvailable")
    : t("connectorUpgrade.hermesBadge");
  const aria = level
    ? t(outdated ? "connectorUpgrade.badgeAria" : "connectorUpgrade.badgeAvailableAria")
    : t("connectorUpgrade.hermesBadgeAria", { version: hermes!.latest! });
  return (
    <Link
      to="/settings/runtime"
      search={{ section: "status" }}
      data-connector-upgrade=""
      data-closes-drawer=""
      aria-label={aria}
      className={className}
      onClick={onNavigate}
    >
      <span className="relative inline-flex">
        <RiServerLine className="size-5 shrink-0" />
        <span aria-hidden className={cn("pointer-events-none absolute -top-0.5 -right-0.5 size-2", outdated ? WARN_DOT : INFO_DOT)} />
      </span>
      <span className="inline-flex min-w-0 items-center truncate px-1">{label}</span>
    </Link>
  );
}
