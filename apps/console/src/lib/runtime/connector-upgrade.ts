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
export type HermesVersionState =
  | { kind: "unknown"; upstream: string | null }
  | { kind: "current"; version: string; upstream: string | null }
  | { kind: "behind"; version: string; latest: string; upstream: string | null };

/**
 * The Hermes the host runs, for the always-visible status row: unknown until
 * the host announces a stable version (an older edge-setup, an unreadable
 * install, a canary), then up to date or behind the latest edge-setup pin.
 * `upstream`: a newer Hermes published upstream, not yet pinned by edge-setup.
 */
export function hermesVersionState(link: RuntimeLinkDto | null | undefined): HermesVersionState {
  const update = link?.hermesUpdate;
  const upstream = update?.upstream ?? null;
  if (!update?.current) return { kind: "unknown", upstream };
  if (update.available && update.latest) return { kind: "behind", version: update.current, latest: update.latest, upstream };
  return { kind: "current", version: update.current, upstream };
}

export function hermesUpdate(link: RuntimeLinkDto | null | undefined): RuntimeHermesUpdateDto | null {
  const update = link?.hermesUpdate;
  return update?.available && update.current && update.latest ? update : null;
}
