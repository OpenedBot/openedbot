import type {
  CreateHermesRunInput,
  SteerHermesRunInput,
  HermesRunDetails,
  HermesEvent,
} from "../contracts";
import { HermesClientError, abortedRequestDelivery } from "../errors";
import { HermesSseError, parseHermesEvents } from "../sse";
import {
  isEventStreamContentType as isEventStreamContentTypeParser,
  normalizeHermesRunDetails as parseRunDetails,
} from "../parsers";
import type { HermesClientContext } from "./context";
import { hermesRunRequestBody } from "./run-body";

export async function createRun(ctx: HermesClientContext, input: CreateHermesRunInput): Promise<string> {
  let timedOut = false;
  const requestController = new AbortController();
  const timeout = setTimeout(() => {
    timedOut = true;
    requestController.abort("create_timeout");
  }, ctx.timeouts.createRunMs);
  const abortRequest = () => requestController.abort(input.signal?.reason ?? "run_aborted");
  if (input.signal?.aborted) abortRequest();
  else input.signal?.addEventListener("abort", abortRequest, { once: true });
  try {
    const response = await ctx.fetch("/v1/runs", {
      method: "POST",
      signal: requestController.signal,
      headers: {
        "Content-Type": "application/json",
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify(hermesRunRequestBody(input)),
    }, "mutation");
    if (!response.ok) await ctx.throwResponse(response);
    let body: { run_id?: unknown };
    try {
      body = (await response.json()) as { run_id?: unknown };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new HermesClientError(
        "Hermes a accepté la création sans renvoyer une réponse JSON exploitable ; son résultat doit être réconcilié.",
        502,
        "HERMES_CREATE_AMBIGUOUS",
        { requestDelivery: "response_received", cause: error },
      );
    }
    if (typeof body.run_id !== "string" || !body.run_id) {
      throw new HermesClientError(
        "Hermes a accepté la création sans renvoyer d’identifiant ; son résultat doit être réconcilié.",
        502,
        "HERMES_CREATE_AMBIGUOUS",
        { requestDelivery: "response_received" },
      );
    }
    return body.run_id;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      const requestDelivery = abortedRequestDelivery(error);
      throw new HermesClientError(
        requestDelivery === "not_sent"
          ? "La création du run Hermes a été annulée avant envoi."
          : timedOut
            ? "La création du run Hermes a expiré après un envoi possible ; son résultat doit être réconcilié."
            : "La création du run Hermes a été interrompue après un envoi possible ; son résultat doit être réconcilié.",
        504,
        requestDelivery === "not_sent" ? "HERMES_UNREACHABLE" : "HERMES_CREATE_AMBIGUOUS",
        { requestDelivery, cause: error },
      );
    }
    if (error instanceof HermesClientError && error.requestDelivery === "ambiguous") {
      throw new HermesClientError(
        "La création du run Hermes a pu être reçue sans que sa réponse soit observable ; son résultat doit être réconcilié.",
        error.status,
        "HERMES_CREATE_AMBIGUOUS",
        {
          requestDelivery: "ambiguous",
          retryAfterMs: error.retryAfterMs,
          // Seule la référence traverse ce ré-emballage. Le diagnostic brut
          // reste dans la cause en mémoire et ne doit atteindre aucun log.
          reference: error.reference,
          cause: error,
        },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortRequest);
  }
}

/** GET /v1/runs/:id : état Hermes utilisé par la réconciliation. */
export async function getRunStatus(ctx: HermesClientContext, hermesRunId: string, signal?: AbortSignal): Promise<HermesRunDetails> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort("status_timeout");
  }, ctx.timeouts.runStatusMs);
  const abortRequest = () => controller.abort(signal?.reason ?? "run_aborted");
  if (signal?.aborted) abortRequest();
  else signal?.addEventListener("abort", abortRequest, { once: true });
  try {
    let response: Response;
    try {
      response = await ctx.fetch(`/v1/runs/${encodeURIComponent(hermesRunId)}`, {
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new HermesClientError(
          timedOut
            ? "Hermes n’a pas renvoyé l’état du run dans le délai imparti."
            : "La lecture de l’état du run Hermes a été annulée.",
          timedOut ? 504 : 499,
          "HERMES_UNREACHABLE",
          { requestDelivery: abortedRequestDelivery(error), cause: error },
        );
      }
      throw error;
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new HermesClientError(
        "Le run Hermes est introuvable.",
        404,
        "HERMES_RUN_MISSING",
        { requestDelivery: "response_received" },
      );
    }
    if (!response.ok) await ctx.throwResponse(response, { profileMissingOn404: false });

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new HermesClientError(
        "Hermes a renvoyé un état de run non JSON.",
        502,
        "HERMES_RESPONSE_INVALID",
        { requestDelivery: "response_received", cause: error },
      );
    }
    return parseRunDetails(body, hermesRunId);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortRequest);
  }
}

/**
 * Le flux SSE du run. `since` demande le rejeu à partir du numéro qui suit
 * (query `?since=` ET `Last-Event-ID`, les deux formes du contrat) ; chaque
 * événement rejoué porte alors `sequence`, lu dans le champ SSE `id:`.
 */
export async function* events(
  ctx: HermesClientContext,
  hermesRunId: string,
  signal: AbortSignal,
  options: { since?: number; onOpen?: () => void } = {},
): AsyncGenerator<HermesEvent> {
  const since = options.since;
  const replay = since !== undefined && Number.isSafeInteger(since) && since >= 0;
  const query = replay ? `?since=${since}` : "";
  const response = await ctx.fetch(`/v1/runs/${encodeURIComponent(hermesRunId)}/events${query}`, {
    signal,
    headers: {
      Accept: "text/event-stream",
      ...(replay ? { "Last-Event-ID": String(since) } : {}),
    },
  });
  if (!response.ok) await ctx.throwResponse(response);
  if (!isEventStreamContentTypeParser(response.headers.get("Content-Type"))) {
    await response.body?.cancel().catch(() => undefined);
    throw new HermesClientError(
      "Hermes n’a pas renvoyé un flux text/event-stream.",
      502,
      "HERMES_RESPONSE_INVALID",
      { requestDelivery: "response_received" },
    );
  }
  if (!response.body) {
    throw new HermesClientError(
      "Hermes a répondu sans flux d’événements.",
      502,
      "HERMES_STREAM_INTERRUPTED",
      { requestDelivery: "response_received" },
    );
  }
  options.onOpen?.();
  try {
    for await (const event of parseHermesEvents(response.body)) {
      if (event.run_id !== hermesRunId || !Number.isFinite(event.timestamp)) {
        throw new HermesClientError(
          "Hermes a mélangé ou mal formé les événements du run.",
          502,
          "HERMES_RESPONSE_INVALID",
          { requestDelivery: "response_received" },
        );
      }
      yield event;
    }
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof HermesClientError) throw error;
    if (error instanceof HermesSseError) {
      throw new HermesClientError(
        error.message,
        502,
        "HERMES_PROTOCOL_LIMIT",
        { requestDelivery: "response_received", cause: error },
      );
    }
    throw new HermesClientError(
      "Le flux d’événements Hermes a été interrompu.",
      502,
      "HERMES_STREAM_INTERRUPTED",
      { requestDelivery: "response_received", cause: error },
    );
  }
}

export async function stopRun(ctx: HermesClientContext, hermesRunId: string, signal?: AbortSignal): Promise<void> {
  const response = await ctx.timedMutation(`/v1/runs/${encodeURIComponent(hermesRunId)}/stop`, {
    method: "POST",
    signal,
  });
  if (!response.ok) await ctx.throwResponse(response);
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Hermes 0.23: closes a run left `unknown` (its process vanished mid-turn),
 * so the session's next turns can start. Hermes accepts exactly
 * `{admission_id, execution_generation}`, both read on `GET /v1/runs/{id}`,
 * and replays its receipt to an exact retry.
 */
export async function resolveUnknownRun(
  ctx: HermesClientContext,
  hermesRunId: string,
  admissionId: string,
  executionGeneration: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!admissionId || !Number.isSafeInteger(executionGeneration) || executionGeneration < 0) {
    throw new HermesClientError("resolve-unknown needs the run's admission and generation.", 400, "BODY_INVALID");
  }
  const response = await ctx.timedMutation(`/v1/runs/${encodeURIComponent(hermesRunId)}/resolve-unknown`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ admission_id: admissionId, execution_generation: executionGeneration }),
  });
  if (!response.ok) await ctx.throwResponse(response);
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Injecte une consigne dans le run réellement actif. Hermes la livre au
 * prochain point d'interruption sûr; ce POST ne remplace ni /approval ni
 * /stop et ne doit jamais être rejoué après une issue de transport ambiguë.
 */
export async function steerRun(ctx: HermesClientContext, hermesRunId: string, input: SteerHermesRunInput): Promise<number> {
  const text = input.text.trim();
  if (!text || text.length > 65_536) {
    throw new HermesClientError(
      "La consigne de steering Hermes est vide ou trop longue.",
      400,
      "HERMES_RESPONSE_INVALID",
      { requestDelivery: "not_sent" },
    );
  }
  const response = await ctx.timedMutation(`/v1/runs/${encodeURIComponent(hermesRunId)}/steer`, {
    method: "POST",
    signal: input.signal,
    headers: {
      "Content-Type": "application/json",
      ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
    },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) await ctx.throwResponse(response, { profileMissingOn404: false });
  const status = response.status;
  // Le statut 2xx est l'ACK du steer. Sur le relais worker -> API -> lien,
  // attendre la propagation de l'abandon du corps peut durer jusqu'à la
  // clôture réseau. Un run court peut alors émettre `run.completed` et
  // annuler le signal du steering alors que son ACK HTTP est déjà arrivé.
  // Déclencher l'abandon libère bien le flux, mais il ne doit pas retarder
  // la confirmation durable de la tentative.
  void response.body?.cancel().catch(() => undefined);
  return status;
}

/** Upstream bound on `request_id` (`api_server_runs.py`, approval route). */
export const APPROVAL_REQUEST_ID_MAX_CHARS = 256;

/**
 * The approval body. Hermes 0.23 (the gate carried `execution_generation`)
 * accepts exactly `{request_id, execution_generation, choice}` and answers
 * 400 to any other key. Without a generation, the Hermes 0.22 body.
 */
export function approvalBody(
  choice: "once" | "session" | "always" | "deny",
  requestId: string,
  executionGeneration: number | null,
): Record<string, unknown> {
  if (executionGeneration !== null) {
    return { request_id: requestId, execution_generation: executionGeneration, choice };
  }
  return legacyApprovalBody(choice, requestId);
}

/**
 * @deprecated Hermes 0.22: `approved` beside `choice`, and `request_id` only
 * when the gate named it (positional otherwise). Remove once no host
 * announces a Hermes below 0.23.
 */
function legacyApprovalBody(choice: "once" | "session" | "always" | "deny", requestId: string): Record<string, unknown> {
  return { choice, approved: choice !== "deny", ...(requestId ? { request_id: requestId } : {}) };
}

/**
 * Answers one gate. With `requestId`, Hermes resolves exactly that gate (its
 * `approval.request` id) instead of the oldest pending one; without it the
 * answer stays positional, as before PERM2-A (Hermes 0.22 only). A Hermes
 * 0.23 gate (`executionGeneration` set) is always answered by its id.
 */
export async function respondApproval(
  ctx: HermesClientContext,
  hermesRunId: string,
  choice: "once" | "session" | "always" | "deny",
  signal?: AbortSignal,
  requestId?: string | null,
  executionGeneration?: number | null,
): Promise<void> {
  const exact = requestId?.trim() ?? "";
  const generation = executionGeneration ?? null;
  // No `requestDelivery`: a stored id this bound refuses is a defect, and the
  // relay must park the gate as ambiguous rather than retry it every poll.
  if (requestId != null && (!exact || exact.length > APPROVAL_REQUEST_ID_MAX_CHARS)) {
    throw new HermesClientError("The approval request id is invalid.", 400, "BODY_INVALID");
  }
  if (generation !== null && (!exact || !Number.isSafeInteger(generation) || generation < 0)) {
    throw new HermesClientError("A Hermes 0.23 approval needs its request id and execution generation.", 400, "BODY_INVALID");
  }
  const response = await ctx.timedMutation(`/v1/runs/${encodeURIComponent(hermesRunId)}/approval`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(approvalBody(choice, exact, generation)),
  });
  if (!response.ok) await ctx.throwResponse(response);
  await response.body?.cancel().catch(() => undefined);
}
