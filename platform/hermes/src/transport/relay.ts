import { HermesClientError, requestAbortError } from "../errors";
import {
  matchRelayRoute,
  RELAY_FORWARDED_REQUEST_HEADERS,
  RELAY_FORWARDED_RESPONSE_HEADERS,
} from "@openedbot/contracts-connector";
import { RELAY_MAX_REQUEST_BODY, type RelayErrStage } from "@openedbot/contracts-connector";
import type { HermesRequestKind, HermesTransport } from "./types";

/** La requête telle que le lien la transporte : ni URL, ni bearer, ni cookie. */
export type RelayRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | Uint8Array | null;
};

/**
 * Celui qui tient le WebSocket. Il rend la `Response` dès le `res` de l'hôte,
 * corps en flux, ou lève : une `RelayDialError` datée de son étape quand il
 * sait où la requête en était, un `AbortError` si `signal` a joué.
 */
export type RelayDialer = (request: RelayRequest, signal?: AbortSignal) => Promise<Response>;

/**
 * Panne du lien, avec l'étape à laquelle elle est survenue.
 *
 * `before_dispatch` : la requête n'a jamais atteint le gateway (lien absent,
 * file pleine, chemin refusé par l'hôte). `after_dispatch` : elle est partie
 * et sa réponse est perdue : Hermes a peut-être agi.
 */
export class RelayDialError extends Error {
  constructor(
    message: string,
    readonly stage: RelayErrStage,
    readonly code: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RelayDialError";
  }
}

export type HermesRelayTransportOptions = {
  runtimeId: string;
  dial: RelayDialer;
};

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Transport `relay` : la requête part dans le lien connecteur du runtime.
 *
 * Il ne compose aucune URL, ne porte aucun bearer et ne relaie que les
 * en-têtes du contrat. L'allowlist est vérifiée ICI, avant d'appeler le
 * lien : un chemin hors liste ne quitte pas le processus.
 *
 * Certitude de livraison :
 *   - refus d'allowlist, corps hors borne, signal déjà annulé,
 *     `RelayDialError` `before_dispatch` → `not_sent` ;
 *   - `RelayDialError` `after_dispatch`, panne inconnue du lien →
 *     `ambiguous` pour une mutation, `null` pour une lecture ;
 *   - réponse reçue puis corps interrompu → `response_received`,
 *     `HERMES_STREAM_INTERRUPTED`.
 */
export function createRelayTransport(options: HermesRelayTransportOptions): HermesTransport {
  return {
    kind: "relay",
    async send(path: string, init: RequestInit, requestKind: HermesRequestKind): Promise<Response> {
      const method = (init.method ?? "GET").toUpperCase();
      if (!matchRelayRoute(method, path)) {
        throw new HermesClientError(
          "Le lien connecteur ne relaie pas cette route Hermes.",
          403,
          "HERMES_LINK_PATH_FORBIDDEN",
          { requestDelivery: "not_sent" },
        );
      }
      if (init.signal?.aborted) throw requestAbortError("not_sent", init.signal.reason);

      const headers: Record<string, string> = { accept: "application/json" };
      new Headers(init.headers).forEach((value, key) => {
        const name = key.toLowerCase();
        if (RELAY_FORWARDED_REQUEST_HEADERS.has(name)) headers[name] = value;
      });
      const body = relayBody(init.body);

      let response: Response;
      try {
        response = await options.dial({ method, path, headers, body }, init.signal ?? undefined);
      } catch (error) {
        throw classifyDialFailure(error, requestKind);
      }
      return relayResponse(response);
    },
  };
}

function relayBody(body: RequestInit["body"]): RelayRequest["body"] {
  if (body === undefined || body === null) return null;
  let bytes: Uint8Array | null = null;
  if (typeof body === "string") bytes = new TextEncoder().encode(body);
  else if (body instanceof Uint8Array) bytes = body;
  else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
  if (bytes) {
    if (bytes.byteLength > RELAY_MAX_REQUEST_BODY) {
      throw new HermesClientError(
        `Le corps de la requête dépasse ${RELAY_MAX_REQUEST_BODY} octets, la borne du lien connecteur.`,
        413,
        "HERMES_PROTOCOL_LIMIT",
        { requestDelivery: "not_sent" },
      );
    }
    return bytes;
  }
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  // Blob, FormData, URLSearchParams : `Response` sait les sérialiser en flux.
  return new Response(body).body;
}

function classifyDialFailure(error: unknown, requestKind: HermesRequestKind): Error {
  if (error instanceof HermesClientError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return requestAbortError("ambiguous", error);
  }
  const stage = dialStage(error);
  const code = error instanceof RelayDialError ? error.code : null;
  if (stage === "before_dispatch") {
    if (code === "HERMES_LINK_PATH_FORBIDDEN") {
      return new HermesClientError(
        "Le lien connecteur ne relaie pas cette route Hermes.",
        403,
        "HERMES_LINK_PATH_FORBIDDEN",
        { requestDelivery: "not_sent", cause: error },
      );
    }
    // Le connecteur a refusé une route hôte parce que son opérateur ne
    // répond pas : rien n'a atteint l'hôte, et le code doit rester lisible
    // (« l'hôte n'a pas d'opérateur » n'est pas « le lien est en panne »).
    if (code === "HERMES_OPERATOR_UNAVAILABLE") {
      return new HermesClientError(
        "L’opérateur de l’hôte ne répond pas : la route hôte n’a pas été servie.",
        503,
        "HERMES_OPERATOR_UNAVAILABLE",
        { requestDelivery: "not_sent", cause: error },
      );
    }
    return new HermesClientError(
      "Le runtime Hermes est inaccessible par son lien connecteur.",
      503,
      "HERMES_UNREACHABLE",
      { requestDelivery: "not_sent", cause: error },
    );
  }
  // Après l'envoi, ou sans étape connue : on ne peut pas prétendre que le
  // gateway n'a rien reçu.
  return new HermesClientError(
    "Le lien connecteur du runtime Hermes a été interrompu.",
    502,
    "HERMES_UNREACHABLE",
    { requestDelivery: requestKind === "mutation" ? "ambiguous" : null, cause: error },
  );
}

function dialStage(error: unknown): RelayErrStage | null {
  if (error instanceof RelayDialError) return error.stage;
  const stage = error && typeof error === "object" ? (error as { stage?: unknown }).stage : null;
  return stage === "before_dispatch" || stage === "after_dispatch" ? stage : null;
}

/**
 * Rejoue la réponse du lien avec les seuls en-têtes du contrat et un corps
 * dont une interruption devient une `HermesClientError` classée
 * `response_received` : l'appelant sait que le gateway a répondu.
 */
function relayResponse(response: Response): Response {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (RELAY_FORWARDED_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  const body = response.body && !NULL_BODY_STATUSES.has(response.status)
    ? guardedBody(response.body)
    : null;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function guardedBody(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        controller.error(relayStreamInterrupted(error));
        return;
      }
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Une lecture qui échoue après le `res` de l'hôte est une interruption de flux, pas une absence d'envoi. */
export function relayStreamInterrupted(cause: unknown): HermesClientError {
  return new HermesClientError(
    "Le flux de réponse du lien connecteur a été interrompu.",
    502,
    "HERMES_STREAM_INTERRUPTED",
    { requestDelivery: "response_received", cause },
  );
}
