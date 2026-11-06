/**
 * La sonde d'un lien connecteur, telle que l'opérateur la déclenche depuis les
 * réglages du runtime (« Vérifier le lien »).
 *
 * Elle passe par le ping WebSocket natif, pas par une trame du protocole :
 * l'hôte y répond sans rien connaître de cette sonde, quel que soit son âge.
 * Un ping sans pong ne suffit pas à déclarer le lien mort : si une autre trame
 * est arrivée pendant la fenêtre, la socket vit et n'était qu'occupée.
 */

/** Fenêtre du pong. Au-delà de la cadence des pings de Bun, sous la limite d'une requête HTTP. */
export const LINK_PROBE_TIMEOUT_MS = 5_000;

/** Raison de fermeture quand le ping reste sans réponse : l'hôte redial (4005). */
export const LINK_RECONNECT_REASON = "LINK_RECONNECT_REQUESTED";

export type LinkProbeResult =
  /** Pong reçu (`rttMs`), ou trame reçue pendant la fenêtre sans pong (`rttMs: null`, lien occupé). */
  | { outcome: "alive"; generation: string | null; rttMs: number | null }
  /** Rien reçu : openedbot a raccroché CETTE connexion (4005), l'hôte se reconnecte. */
  | { outcome: "reconnect_requested"; generation: string | null }
  /** Une autre connexion tient le lien depuis la lecture : rien n'a été fermé. */
  | { outcome: "generation_changed"; generation: string | null }
  /** Le ping n'a pas pu partir (socket saturée) : ni vivant, ni mort. */
  | { outcome: "indeterminate"; generation: string | null }
  /** Aucune instance ne tient de lien pour ce runtime. */
  | { outcome: "no_link" }
  /** L'instance propriétaire du lien ne répond plus. */
  | { outcome: "owner_unavailable" };

export type LinkProbeOutcome = LinkProbeResult["outcome"];

const GENERATION_PATTERN = /^[0-9]{1,20}$/;

/** Relit la réponse d'une autre instance : une forme inconnue vaut `owner_unavailable`. */
export function parseLinkProbeResult(value: unknown): LinkProbeResult {
  if (!value || typeof value !== "object") return { outcome: "owner_unavailable" };
  const body = value as { outcome?: unknown; generation?: unknown; rttMs?: unknown };
  const generation = typeof body.generation === "string" && GENERATION_PATTERN.test(body.generation) ? body.generation : null;
  switch (body.outcome) {
    case "alive": {
      const rttMs = typeof body.rttMs === "number" && Number.isFinite(body.rttMs) && body.rttMs >= 0 ? Math.round(body.rttMs) : null;
      return { outcome: "alive", generation, rttMs };
    }
    case "reconnect_requested":
    case "generation_changed":
    case "indeterminate":
      return { outcome: body.outcome, generation };
    case "no_link":
      return { outcome: "no_link" };
    default:
      return { outcome: "owner_unavailable" };
  }
}

/** La génération attendue, lue en base avant la sonde ; tout le reste vaut `null`. */
export function parseProbeGeneration(value: unknown): string | null {
  return typeof value === "string" && GENERATION_PATTERN.test(value) ? value : null;
}
