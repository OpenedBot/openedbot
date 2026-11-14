/**
 * How openedbot reaches the runtime.
 *
 * `connector` is the only state produced. `direct` stays in this union long
 * enough to read and revoke the rows created by the historical migrations;
 * no API can create one anymore and the worker no longer executes them.
 */
export type RuntimeReachability = "direct" | "connector";

export type RuntimeConnectorDto = {
  agent: string;
  version: string | null;
  latestVersion: string | null;
  minimumVersion: string | null;
  outdated: boolean;
  updateAvailable: boolean;
  seenAt: string | null;
  upgradeCommand: "sudo edge-setup upgrade --yes";
};

/**
 * Hermes on the host compared with the one the latest edge-setup
 * release installs. `current`: the stable version announced in `hello`, null if
 * the host did not say or a canary. Present as soon as the connector has said
 * hello, so the console can show the installed Hermes, or that it is unknown. `available` is true only if both
 * are known and `latest` is newer. Hermes updates with edge-setup,
 * on the host: openedbot never does it.
 */
export type RuntimeHermesUpdateDto = {
  current: string | null;
  latest: string | null;
  available: boolean;
  /**
   * The latest stable Hermes released upstream, only when newer than `latest`:
   * published by Hermes, not yet pinned by edge-setup (no command installs it).
   * Absent from an older API.
   */
  upstream?: string | null;
  /** Updates edge-setup alone: needed first only while the connector is behind. */
  upgradeCommand: "sudo edge-setup upgrade --yes";
  /**
   * Installs the Hermes the host's edge-setup pins. `upgrade` never does:
   * it replaces the binary and repairs the checkout, Hermes stays as it is.
   */
  upCommand: "sudo edge-setup up --yes";
};

/**
 * The latest public edge-setup release, as the API read it (the anchor
 * `releases.openedbot.app/edge-setup/edge-setup.json`, or a mirror's release):
 * its notes are the CHANGELOG section, in bounded markdown, with no HTML, or
 * empty when the anchor carries none.
 */
export type ConnectorReleaseDto = {
  version: string;
  publishedAt: string | null;
  notes: string;
  url: string;
  /** The Hermes this release pins (`tool.hermesVersion` of the anchor); absent or null if it is not published. */
  hermesVersion?: string | null;
};

/**
 * `GET /api/runtimes/connector-release`. `seen`: the user has already closed
 * the announcement of this version in this organization. openedbot never updates
 * the host itself: it only hands back the two commands.
 */
export type ConnectorReleaseResponse = {
  release: ConnectorReleaseDto | null;
  seen: boolean;
  upgradeCommand: "sudo edge-setup upgrade --yes";
  autoUpgradeCommand: "sudo edge-setup auto-upgrade enable --yes";
};
