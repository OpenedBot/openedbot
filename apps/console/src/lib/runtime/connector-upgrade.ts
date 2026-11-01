import type { RuntimeConnectorDto } from "@openedbot/contracts-api";

/**
 * What the owner must hear about the host's connector. `outdated`: below the
 * supported minimum, the upgrade is required. `available`: a newer release
 * exists. openedbot never upgrades the host itself (release boundary): it can only
 * hand the owner `upgradeCommand`.
 */
export type ConnectorUpgradeLevel = "outdated" | "available";

export function connectorUpgradeLevel(connector: RuntimeConnectorDto | null | undefined): ConnectorUpgradeLevel | null {
  if (!connector) return null;
  if (connector.outdated) return "outdated";
  if (connector.updateAvailable) return "available";
  return null;
}
