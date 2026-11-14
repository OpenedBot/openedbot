/**
 * Canaux du journal, équivalent Monolog (`monolog.logger.<canal>`).
 *
 * Ce n'est pas un fichier par canal : journald reste l'unique destination.
 * Le champ `channel` est une étiquette de faible cardinalité pour filtrer
 * (`jq 'select(.channel=="auth")'`), jamais un label Loki.
 */

export const LOG_CHANNELS = ["api", "http", "email", "auth", "runtime_link"] as const;

export type LogChannel = (typeof LOG_CHANNELS)[number];

/**
 * Canal déduit du nom d'événement. Un call site peut forcer `channel` ; le
 * mixin ne l'écrase pas. L'access-log n'a pas de champ `event` : son canal
 * `http` est posé par le child logger, pas par cette fonction.
 */
export function channelOf(event: string): LogChannel {
  if (event.includes("email") || event.endsWith("_enqueue_failed")) return "email";
  if (event.startsWith("auth.")) return "auth";
  if (event.startsWith("runtime_link.")) return "runtime_link";
  return "api";
}
