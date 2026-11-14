/**
 * Bornage d'un transcript Hermes au tour courant.
 *
 * Une session de bot est PERSISTANTE : `GET /api/sessions/{id}/messages` rend
 * les derniers messages de la session entière, tours précédents compris. Les
 * projections de lecture du fil (plan `todo`, recherches web) ne parlent, elles,
 * que du run en cours : sans borne, la trace d'un message se voit recoller les
 * requêtes et les étapes des tours d'avant.
 *
 * La borne est le DERNIER message `user` du transcript, exclu : tout ce qui le
 * suit appartient au tour qu'il a ouvert. C'est l'ancrage que l'amont utilise
 * lui-même pour retrouver un tour (`SessionDB.latest_message_row_id(role="user")`,
 * `hermes_state_messages.py`).
 *
 * Le transcript livré par `run.completed` (`_turn_transcript_messages`,
 * `gateway/platforms/api_server_openai_routes.py`) est déjà borné au tour : il
 * n'a pas besoin de passer ici, et n'y perdrait rien puisqu'il ne porte aucun
 * message `user`.
 */

/**
 * La queue du transcript à partir du dernier message `user`, celui-ci exclu.
 *
 * Sans message `user` lu, tout est rendu : c'est le cas d'un transcript déjà
 * borné au tour, et taire une trace réellement jouée serait pire que la garder
 * entière.
 */
export function currentTurnMessages(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>).role
      : null;
    if (role === "user") return messages.slice(index + 1);
  }
  return [...messages];
}
