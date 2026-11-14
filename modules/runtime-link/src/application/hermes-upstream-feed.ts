import { parseHermesVersion, type ConnectorVersions } from "@openedbot/platform-config/connector-version";
import { logger } from "@openedbot/platform-observability";

/**
 * La dernière release stable de Hermes en amont, relue toutes les 6 heures.
 *
 * edge-setup épingle un Hermes et seul ce pin s'installe : sans cette lecture,
 * la console disait « à jour » à un hôte en retard sur une version que Hermes
 * avait déjà publiée. La version relevée va dans l'objet vivant
 * `config.connectorVersions.hermesUpstreamVersion`, lu à chaque requête. Une
 * lecture ratée garde la dernière valeur connue ; une pré-release, un
 * brouillon ou un tag illisible ne la remplacent jamais.
 */
export const HERMES_UPSTREAM_REFRESH_MS = 6 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

/** Le JSON de `GET /repos/{repo}/releases/latest` ; null hors version stable. */
export function parseHermesUpstreamRelease(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const release = json as Record<string, unknown>;
  if (release.draft === true || release.prerelease === true) return null;
  return parseHermesVersion(typeof release.tag_name === "string" ? release.tag_name : null);
}

export type HermesUpstreamFeed = { refresh(): Promise<void>; start(): void; stop(): void };

export function createHermesUpstreamFeed(deps: {
  url: string | null;
  versions: ConnectorVersions;
  fetch?: typeof fetch;
  intervalMs?: number;
}): HermesUpstreamFeed {
  const fetchImpl = deps.fetch ?? fetch;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    if (!deps.url) return;
    try {
      const response = await fetchImpl(deps.url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "openedbot-api" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.warn({ status: response.status, code: "HERMES_UPSTREAM_HTTP" }, "hermes.upstream.refresh_failed");
        return;
      }
      const version = parseHermesUpstreamRelease(await response.json());
      if (!version) {
        logger.warn({ code: "HERMES_UPSTREAM_INVALID" }, "hermes.upstream.refresh_failed");
        return;
      }
      if (deps.versions.hermesUpstreamVersion !== version) {
        deps.versions.hermesUpstreamVersion = version;
        logger.info({ hermesUpstreamVersion: version }, "hermes.upstream.latest");
      }
    } catch (error) {
      logger.warn({ code: "HERMES_UPSTREAM_FETCH", error: error instanceof Error ? error.name : "unknown" }, "hermes.upstream.refresh_failed");
    }
  }

  return {
    refresh,
    start() {
      if (!deps.url || timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), deps.intervalMs ?? HERMES_UPSTREAM_REFRESH_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
