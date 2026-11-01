export type RuntimeLinkConfig = {
  mode: "embedded" | "separate";
  host: string;
  port: number;
  internalUrl: string;
  drainTimeoutMs: number;
  dbMax: number;
};

/**
 * Pool PostgreSQL de la passerelle, indépendant de `API_DB_MAX`.
 *
 * Mesuré en régime établi : UNE connexion ouverte pour tout le travail de la
 * passerelle (heartbeat d'instance, `seen`, événements, `locate` d'un relais).
 * Elle héritait pourtant du pool d'une API complète, 32 places réservées sur
 * un PostgreSQL qui en compte 100. Trois répliques plus un worker, ou un
 * déploiement progressif qui double les processus le temps d'une bascule, et
 * le serveur n'a plus de place : la passerelle n'obtient plus rien, son
 * heartbeat sort en `ERR_POSTGRES_CONNECTION_TIMEOUT`, et le lien connecteur
 * du client reste fermé faute de pouvoir écrire la moindre ligne.
 *
 * 16 laisse seize fois la charge observée tout en rendant la moitié des
 * places. Le relais `locate` est le seul chemin qui monte avec le trafic :
 * remonter cette borne est un réglage, pas une reprise de contrat.
 */
export const RUNTIME_LINK_DB_MAX_DEFAULT = 16;

/** Connector process settings are independent of the public API's listener. */
export function readRuntimeLinkConfig(env: Record<string, string | undefined> = process.env): RuntimeLinkConfig {
  const mode = env.RUNTIME_LINK_MODE?.trim() || "embedded";
  if (mode !== "embedded" && mode !== "separate") throw new Error("RUNTIME_LINK_MODE must be embedded or separate.");
  const host = env.RUNTIME_LINK_HOST?.trim() || "127.0.0.1";
  const port = boundedInteger(env.RUNTIME_LINK_PORT, 8791, 1, 65_535, "RUNTIME_LINK_PORT");
  const drainTimeoutMs = boundedInteger(env.RUNTIME_LINK_DRAIN_TIMEOUT_MS, 30_000, 0, 300_000, "RUNTIME_LINK_DRAIN_TIMEOUT_MS");
  const dbMax = boundedInteger(env.RUNTIME_LINK_DB_MAX, RUNTIME_LINK_DB_MAX_DEFAULT, 1, 256, "RUNTIME_LINK_DB_MAX");
  const explicit = env.RUNTIME_LINK_INTERNAL_URL?.trim();
  if (mode === "separate" && !explicit) throw new Error("RUNTIME_LINK_INTERNAL_URL is required when RUNTIME_LINK_MODE=separate.");
  let origin: URL;
  try {
    origin = new URL(explicit || `http://127.0.0.1:${port}`);
  } catch {
    throw new Error("RUNTIME_LINK_INTERNAL_URL must be an HTTP(S) origin.");
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("RUNTIME_LINK_INTERNAL_URL must be an HTTP(S) origin without credentials, path, query or fragment.");
  }
  return { mode, host, port, internalUrl: origin.origin, drainTimeoutMs, dbMax };
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return parsed;
}
