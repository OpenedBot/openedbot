import type { RuntimeConnectorDto, RuntimeHermesUpdateDto } from "@openedbot/contracts-api";

export type ConnectorVersions = {
  minimumVersion?: string | null;
  latestVersion?: string | null;
  /**
   * Le Hermes épinglé par la dernière release d'edge-setup, relevé en place
   * par le flux des releases (`tool.hermesVersion` de l'ancre). Absent ou
   * null : `EDGE_SETUP_HERMES_VERSION`.
   */
  hermesVersion?: string | null;
};

/**
 * Le Hermes épinglé par l'edge-setup de ce dépôt
 * (`edge-setup/internal/pins/pins.go`, `HermesVersion`), tenu égal par
 * `platform/config/tests/connector-version.test.ts`. C'est la version
 * qu'un hôte reçoit avec `edge-setup upgrade` tant que l'ancre publique ne
 * dit pas mieux.
 */
export const EDGE_SETUP_HERMES_VERSION = "0.22.2";

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

/**
 * Une version Hermes stable, sans préfixe (`0.22.6`). Les tags amont
 * `v0.22.5+canary.<horodatage>` et toute pré-release rendent null : une
 * canary n'est jamais une mise à jour.
 */
export function parseHermesVersion(value: string | null | undefined): string | null {
  return parseConnectorVersion(value)?.slice(1) ?? null;
}

/**
 * Hermes a-t-il plus récent pour cet hôte ? `current` est ce que l'hôte a
 * annoncé dans `hello`, `latest` ce que la dernière release d'edge-setup
 * installe. Une valeur inconnue ou illisible d'un côté : jamais d'alerte.
 * openedbot ne met pas Hermes à jour : seul `edge-setup upgrade` le fait.
 */
export function runtimeHermesUpdate(
  announced: string | null | undefined,
  versions: ConnectorVersions = {},
): RuntimeHermesUpdateDto {
  const current = parseHermesVersion(announced);
  const latest = parseHermesVersion(versions.hermesVersion) ?? parseHermesVersion(EDGE_SETUP_HERMES_VERSION);
  return {
    current,
    latest,
    available: connectorVersionBelow(current, latest),
    upgradeCommand: "sudo edge-setup upgrade --yes",
  };
}
