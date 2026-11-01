/**
 * Rafale de messages : la politique « supersede + prepend » de Grok Bot.
 *
 * Mesuré le 2026-09-11 sur l'app macOS Grok Bot (bundle com.anysphere.sand)
 * et lu dans sa reconstruction (`send-turn-dispatch.ts#dispatchUserTurn`,
 * `user-message-action-handler.ts`) : un message reçu pendant que le bot
 * réfléchit TUE le tour en cours et relance UN tour qui porte tous les
 * messages non confirmés, dans l'ordre. L'utilisateur reçoit une seule
 * réponse (« Tokyo pour le Japon, Mexico pour le Mexique »).
 *
 * hermes-agent a le mécanisme (`agent/interrupt_control.py#redirect`) mais
 * `gateway/platforms/api_server_runs.py` ne l'expose pas sur `/v1`, et le
 * `/steer` n'est lu qu'à la frontière d'outil suivante. openedbot tranche donc à
 * l'admission du message, avec trois issues :
 *
 * - `fold` : le run précédent est encore en file, jamais réclamé : le message
 *   rejoint son entrée, aucun nouveau run.
 * - `supersede` : le run précédent tourne mais n'a encore rien montré (ni
 *   texte, ni appel d'outil, ni approbation) : il est arrêté avec
 *   `SUPERSEDED_BY_FOLLOWUP` et le nouveau run porte son entrée PLUS le
 *   nouveau message. Son message reste dans le fil, sans bulle d'erreur.
 * - `steer` : le run précédent a déjà montré du travail : `POST /steer`,
 *   comme avant ; un steer jamais lu revient dans `pending_steer` et tous
 *   les non-lus sont rejoués en UN run (`folded_into_followup` pour les
 *   suivants).
 */

export const FOLLOWUP_SUPERSEDE_MESSAGE = "Remplacé par le message suivant.";

/** Le `system.notice` posé sur un run remplacé : un repère muet, jamais une erreur. */
export const SUPERSEDED_NOTICE_KIND = "superseded";

/** `runs.completion_kind` d'un run arrêté parce qu'un message l'a remplacé. */
export const SUPERSEDED_COMPLETION_KIND = "superseded_by_followup";
/** `runs.completion_kind` d'un run de repli absorbé par le run actif (`/steer`). */
export const STEERED_COMPLETION_KIND = "steered_into_active";
/** `runs.completion_kind` d'un run de repli replié dans le run de rejeu qui le précède. */
export const FOLDED_COMPLETION_KIND = "folded_into_followup";

/**
 * Un run absorbé : annulé sans réponse propre parce qu'un autre run porte son
 * message. Le fil le lit sous le run absorbant, avec « Pris en compte ».
 */
export function isAbsorbedRun(run: { status: string; completionKind?: string | null }): boolean {
  return run.status === "cancelled"
    && (run.completionKind === STEERED_COMPLETION_KIND || run.completionKind === FOLDED_COMPLETION_KIND);
}

/**
 * Plusieurs messages, UN tour utilisateur. Une seule chaîne, jamais un
 * tableau : sur `/v1/runs`, un `input` en liste fait des premiers éléments
 * de l'historique et du dernier seul le message du tour
 * (`api_server_runs.py#_resolve_conversation_history`). Une ligne vide sépare
 * les messages, comme l'amont sépare ses steers agrégés.
 */
export function mergeFollowupInputs(parts: readonly string[]): string {
  const blocks: string[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (text.length > 0) blocks.push(text);
  }
  return blocks.join("\n\n");
}
