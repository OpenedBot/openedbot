import type { ConnectorReleaseResponse } from "@openedbot/contracts-api";
import { RELAY_FEATURE_AUTO_UPGRADE } from "@openedbot/contracts-connector/features";

/** The command that enables automatic updates on the host, typed by the contract. */
export const AUTO_UPGRADE_COMMAND: ConnectorReleaseResponse["autoUpgradeCommand"] = "sudo edge-setup auto-upgrade enable --yes";

/**
 * `true` when the host advertises `auto_upgrade`: its timer installs newer
 * releases on its own. Also false for a connector too old to
 * say so: the console then offers the command, with no effect if the timer is running.
 */
export function hasAutoUpgrade(features: readonly string[] | null | undefined): boolean {
  return Boolean(features?.includes(RELAY_FEATURE_AUTO_UPGRADE));
}
