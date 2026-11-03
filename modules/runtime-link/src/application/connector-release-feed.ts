import type { ConnectorReleaseDto } from "@openedbot/contracts-api";
import { connectorVersionBelow, parseConnectorVersion, parseHermesVersion, type ConnectorVersions } from "@openedbot/platform-config/connector-version";
import { logger } from "@openedbot/platform-observability";

/**
 * La dernière release publique d'edge-setup, relue toutes les heures.
 *
 * `RUNTIME_CONNECTOR_LATEST_VERSION` était posée à la main dans le secret de
 * la prod, et restait en retard (v0.5.8 annoncée le jour où v0.5.9 sortait) :
 * aucun propriétaire ne voyait « mise à jour disponible ». Le flux lit l'ancre
 * `https://releases.openedbot.app/edge-setup/edge-setup.json`, que la
 * publication d'une release écrit juste avant `LATEST`
 * (edge-setup/scripts/publish-r2.sh), ou le JSON d'une release
 * GitHub si l'URL configurée vise encore un miroir, relève la dernière version
 * dans l'objet vivant `config.connectorVersions` (lu à chaque requête par les
 * routes et par le gateway du lien) et garde ses notes pour la modale de la
 * console. La variable d'environnement reste le plancher et le repli : une
 * lecture ratée ne fait jamais redescendre la version annoncée.
 *
 * L'ancre peut aussi dire quel Hermes cette release épingle
 * (`tool.hermesVersion`) : relevé dans `config.connectorVersions.hermesVersion`
 * à chaque lecture réussie, remis à null (le Hermes épinglé par ce dépôt)
 * quand elle ne le dit pas, ou pas sous une forme stable.
 */

/** Une heure : la publication passe déjà par une tâche planifiée toutes les 10 min. */
export const CONNECTOR_RELEASE_REFRESH_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/** Les notes de v0.5.9 font ~3 Ko ; au-delà, la console renvoie vers la release. */
export const CONNECTOR_RELEASE_NOTES_MAX = 12_000;
/** L'ancre ne porte pas de notes : la modale renvoie vers la page publique. */
export const CONNECTOR_RELEASE_PAGE_URL = "https://docs.openedbot.app/docs/edge-setup";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Deux formes, réduites à ce que la console affiche. L'ancre
 * (`{ tool: { version, sha256 } }`) n'est crue qu'avec une version stable et
 * des empreintes SHA-256 bien formées ; un `hermesVersion` canary ou illisible
 * est ignoré sans refuser l'ancre. Le JSON de
 * `GET /repos/{repo}/releases/latest` (un miroir) : une version non stable,
 * une URL hors `https://` ou un brouillon rendent null.
 */
export function parseConnectorRelease(json: unknown): ConnectorReleaseDto | null {
  if (!json || typeof json !== "object") return null;
  const release = json as Record<string, unknown>;
  if ("tool" in release) return parseAnchor(release.tool);
  if (release.draft === true || release.prerelease === true) return null;
  const version = parseConnectorVersion(typeof release.tag_name === "string" ? release.tag_name : null);
  if (!version) return null;
  const url = typeof release.html_url === "string" && release.html_url.startsWith("https://") ? release.html_url : null;
  if (!url) return null;
  const publishedAt = typeof release.published_at === "string" && !Number.isNaN(Date.parse(release.published_at))
    ? new Date(release.published_at).toISOString()
    : null;
  return { version, publishedAt, notes: releaseNotes(typeof release.body === "string" ? release.body : "", version), url, hermesVersion: null };
}

function parseAnchor(tool: unknown): ConnectorReleaseDto | null {
  if (!tool || typeof tool !== "object") return null;
  const { version: raw, sha256, hermesVersion } = tool as Record<string, unknown>;
  const version = parseConnectorVersion(typeof raw === "string" ? raw : null);
  if (!version || !sha256 || typeof sha256 !== "object") return null;
  const digests = Object.values(sha256);
  if (digests.length === 0 || !digests.every((value) => typeof value === "string" && SHA256_HEX.test(value))) return null;
  return {
    version, publishedAt: null, notes: "", url: CONNECTOR_RELEASE_PAGE_URL,
    hermesVersion: parseHermesVersion(typeof hermesVersion === "string" ? hermesVersion : null),
  };
}

/**
 * Le corps commence par le titre « edge-setup vX.Y.Z », déjà porté par la
 * modale. Le HTML brut est retiré : la console rend du markdown, jamais du
 * HTML venu d'ailleurs.
 */
function releaseNotes(body: string, version: string): string {
  const text = body
    .replace(/\r\n?/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(new RegExp(`^\\s*edge-setup ${version.replace(/\./g, "\\.")}\\s*\\n`), "")
    .trim();
  if (text.length <= CONNECTOR_RELEASE_NOTES_MAX) return text;
  const cut = text.lastIndexOf("\n", CONNECTOR_RELEASE_NOTES_MAX);
  return `${text.slice(0, cut > 0 ? cut : CONNECTOR_RELEASE_NOTES_MAX).trimEnd()}\n\n…`;
}

export type ConnectorReleaseFeed = {
  /** La dernière release lue ; null avant la première lecture réussie. */
  current(): ConnectorReleaseDto | null;
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
};

export function createConnectorReleaseFeed(deps: {
  url: string | null;
  /** L'objet vivant de la config : `latestVersion` y est relevé en place. */
  versions: ConnectorVersions;
  fetch?: typeof fetch;
  intervalMs?: number;
}): ConnectorReleaseFeed {
  const fetchImpl = deps.fetch ?? fetch;
  const floor = parseConnectorVersion(deps.versions.latestVersion);
  let release: ConnectorReleaseDto | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    if (!deps.url) return;
    try {
      const response = await fetchImpl(deps.url, {
        headers: { Accept: "application/json, application/vnd.github+json", "User-Agent": "openedbot-api" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.warn({ status: response.status, code: "CONNECTOR_RELEASE_HTTP" }, "connector.release.refresh_failed");
        return;
      }
      const next = parseConnectorRelease(await response.json());
      if (!next) {
        logger.warn({ code: "CONNECTOR_RELEASE_INVALID" }, "connector.release.refresh_failed");
        return;
      }
      release = next;
      const latest = floor && connectorVersionBelow(next.version, floor) ? floor : next.version;
      if (deps.versions.latestVersion !== latest) {
        deps.versions.latestVersion = latest;
        logger.info({ latestVersion: latest }, "connector.release.latest");
      }
      const hermes = next.hermesVersion ?? null;
      if ((deps.versions.hermesVersion ?? null) !== hermes) {
        deps.versions.hermesVersion = hermes;
        logger.info({ hermesVersion: hermes }, "connector.release.hermes");
      }
    } catch (error) {
      logger.warn({ code: "CONNECTOR_RELEASE_FETCH", error: error instanceof Error ? error.name : "unknown" }, "connector.release.refresh_failed");
    }
  }

  return {
    current: () => release,
    refresh,
    start() {
      if (!deps.url || timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), deps.intervalMs ?? CONNECTOR_RELEASE_REFRESH_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
