import type { RuntimeConnectorDto, RuntimeHermesUpdateDto, RuntimeLinkDto } from "@openedbot/contracts-api";

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

/**
 * A newer Hermes ships with the latest edge-setup release. Only an update the
 * API could compare on both sides (stable versions, canaries never count) is
 * said; Hermes is updated with edge-setup, on the host, never by openedbot.
 */
export function hermesUpdate(link: RuntimeLinkDto | null | undefined): RuntimeHermesUpdateDto | null {
  const update = link?.hermesUpdate;
  return update?.available && update.current && update.latest ? update : null;
}
