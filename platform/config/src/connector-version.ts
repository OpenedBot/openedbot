import type { RuntimeConnectorDto } from "@openedbot/contracts-api";

export type ConnectorVersions = { minimumVersion?: string | null; latestVersion?: string | null };

/** Versions stables seulement : ni pré-release, ni build local, ni suffixe dirty. */
export function parseConnectorVersion(value: string | null | undefined): string | null {
  if (!value || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  return value.startsWith("v") ? value : `v${value}`;
}

/** Comparaison numérique des trois composantes, sans perte sur les grands entiers. */
export function connectorVersionBelow(version: string | null | undefined, threshold: string | null | undefined): boolean {
  const current = parseConnectorVersion(version);
  const target = parseConnectorVersion(threshold);
  if (!current || !target) return false;
  const left = current.slice(1).split(".").map(BigInt);
  const right = target.slice(1).split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! < right[index]!;
  }
  return false;
}

/** La version déclarée reste informative même sans seuil configuré. */
export function runtimeConnector(
  agent: string | null | undefined,
  seenAt: string | null,
  versions: ConnectorVersions = {},
): RuntimeConnectorDto | null {
  if (agent == null) return null;
  const minimumVersion = parseConnectorVersion(versions.minimumVersion);
  const latestVersion = parseConnectorVersion(versions.latestVersion);
  // "edge-setup/" est le préfixe canonique ; "hermes-setup/" reste accepté
  // pour les connecteurs déjà en production avant le renommage OHB-87.
  const version = agent.startsWith("edge-setup/")
    ? parseConnectorVersion(agent.slice("edge-setup/".length))
    : agent.startsWith("hermes-setup/")
      ? parseConnectorVersion(agent.slice("hermes-setup/".length))
      : null;
  return {
    agent, version, minimumVersion, latestVersion,
    outdated: connectorVersionBelow(version, minimumVersion),
    updateAvailable: connectorVersionBelow(version, latestVersion),
    seenAt,
    upgradeCommand: "sudo edge-setup upgrade --yes",
  };
}
