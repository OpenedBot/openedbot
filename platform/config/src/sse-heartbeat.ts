/**
 * Cadence du commentaire SSE de maintien. Partagée avec le relais interne du
 * lien connecteur (`runtime-link-routes.ts`) : un flux tenu ouvert sans octet
 * pendant plus longtemps que cela est tenu pour mort par les proxies.
 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
