import {
  SESSION_MESSAGES_PAGE_LIMIT,
  MAX_SESSION_MESSAGES_BODY_BYTES,
  type HermesSessionCounters,
} from "../contracts";
import { HermesClientError, abortedRequestDelivery } from "../errors";
import {
  hermesSessionTitle as sessionTitle,
  normalizeHermesSessionCounters as parseSessionCounters,
} from "../parsers";
import { record } from "../parsers/shared";
import type { HermesClientContext } from "./context";

export async function ensureSession(ctx: HermesClientContext, id: string, title: string, signal?: AbortSignal): Promise<void> {
  // Session creation is deterministic (`id`) and therefore safe to retry,
  // but it is still a remote mutation: never let an accepted request with a
  // missing response consume the whole workflow deadline.
  const response = await ctx.timedMutation("/api/sessions", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, title: sessionTitle(id, title) }),
  });
  if (!response.ok && response.status !== 409) await ctx.throwResponse(response, { retrySessionUnavailable: true });
  await response.body?.cancel().catch(() => undefined);
}

/**
 * GET /api/sessions/:id : compteurs cumulatifs de la session. La ventilation
 * cache n'existe QUE là ; l'appelant est responsable d'en tirer un delta et
 * de ne jamais faire échouer une étape sur cette lecture.
 */
export async function sessionCounters(ctx: HermesClientContext, sessionId: string, signal?: AbortSignal): Promise<HermesSessionCounters> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort("session_counters_timeout");
  }, ctx.timeouts.sessionCountersMs);
  const abortRequest = () => controller.abort(signal?.reason ?? "run_aborted");
  if (signal?.aborted) abortRequest();
  else signal?.addEventListener("abort", abortRequest, { once: true });
  try {
    let response: Response;
    try {
      response = await ctx.fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new HermesClientError(
          timedOut
            ? "Hermes n’a pas renvoyé les compteurs de session dans le délai imparti."
            : "La lecture des compteurs de session Hermes a été annulée.",
          timedOut ? 504 : 499,
          "HERMES_UNREACHABLE",
          { requestDelivery: abortedRequestDelivery(error), cause: error },
        );
      }
      throw error;
    }
    // Une session inconnue n'est pas un profil manquant : le 404 reste un 404.
    if (!response.ok) await ctx.throwResponse(response, { profileMissingOn404: false });
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new HermesClientError(
        "Hermes a renvoyé des compteurs de session non JSON.",
        502,
        "HERMES_RESPONSE_INVALID",
        { requestDelivery: "response_received", cause: error },
      );
    }
    return parseSessionCounters(body);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortRequest);
  }
}

/**
 * Relit la page récente du transcript Hermes. Le runtime ne met pas les
 * arguments d'outils dans le SSE `run.completed`, mais les conserve dans
 * cette route déjà exposée par le gateway. Le worker s'en sert pendant le
 * run, à chaque écriture `todo` ou recherche web, pour projeter le plan et
 * les sources sans changer Hermes. La page porte TOUTE la session, tours
 * précédents compris : c'est à l'appelant de la borner au tour courant
 * (`currentTurnMessages` in the shared agent-transcript helper).
 */
export async function sessionMessages(ctx: HermesClientContext, sessionId: string): Promise<unknown[]> {
  const body = await ctx.json(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${SESSION_MESSAGES_PAGE_LIMIT}&order=latest`,
    { timeoutMs: ctx.timeouts.sessionMessagesMs, maxBytes: MAX_SESSION_MESSAGES_BODY_BYTES },
  );
  const data = record(body)?.data;
  if (!Array.isArray(data)) {
    throw new HermesClientError(
      "Hermes a renvoyé un transcript de session invalide.",
      502,
      "HERMES_RESPONSE_INVALID",
      { requestDelivery: "response_received" },
    );
  }
  // MESURE amont : `order=latest` pagine EN ARRIÈRE depuis le message le
  // plus récent, mais rend la page dans l'ordre CHRONOLOGIQUE
  // (`SessionDB.get_messages`, `hermes_state_messages.py` : `rows.reverse()`
  // quand `latest`, puis `_handle_session_messages` sert ces lignes telles
  // quelles). Renverser ici relisait donc le transcript à l'envers : la
  // projection todo prenait la PREMIÈRE écriture pour la dernière, et les
  // recherches web remontaient de la plus récente à la plus ancienne.
  return data;
}

/**
 * Efface la session et son transcript sur le runtime du client.
 *
 * `DELETE /api/sessions/{id}` est une route du gateway amont
 * (`gateway/platforms/api_server.py`, annoncée dans les capabilities sous
 * `session_delete`) : elle appelle `SessionDB.delete_session`, qui supprime
 * la ligne de session et ses messages. C'est la seule écriture destructive
 * qu'openedbot adresse au runtime, et elle ne porte que sur ce qu'openedbot y a créé :
 * jamais sur le profil, jamais sur une session d'un autre client.
 *
 * Idempotent : un 404 est un succès. Le contrat d'un DELETE est « cette
 * session n'existe plus », pas « j'en ai effacé une ». Un runtime dont le
 * connecteur est antérieur à cette route ne renvoie rien du tout : son
 * allowlist la refuse avant l'aller réseau, en `HERMES_LINK_PATH_FORBIDDEN`
 * (403, `not_sent`). L'appelant doit distinguer les deux : le premier a
 * effacé, le second n'a rien touché.
 */
/** `true` when a session was deleted, `false` when it was already absent (404). */
export async function deleteSession(ctx: HermesClientContext, sessionId: string, signal?: AbortSignal): Promise<boolean> {
  const response = await ctx.timedMutation(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE", signal },
  );
  if (!response.ok && response.status !== 404) await ctx.throwResponse(response);
  await response.body?.cancel().catch(() => undefined);
  return response.ok;
}
