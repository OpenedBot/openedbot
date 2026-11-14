import { internalBearer } from "@openedbot/platform-config/internal-secrets";
import {
  createRelayTransport,
  createDirectTransport,
  decryptSecretFromKeyring,
  HermesClient,
  RelayDialError,
  type RelayDialer,
  type RelayRequest,
} from "@openedbot/hermes";
import { RELAY_STAGE_HEADER, RELAY_TRACEPARENT_HEADER, relayStageOf, type RelayErrStage } from "@openedbot/contracts-connector";
import { logEvent } from "@openedbot/platform-observability";
import { childTraceContext, currentTrace, formatTraceparent, type TraceContext } from "@openedbot/platform-observability/trace-context";
import type { WorkerConfig } from "./worker-config";

/**
 * Le client Hermes d'un run, selon le mode de jonction de son runtime.
 *
 * Le seul transport est `relay` : le dialer pousse la requête au relais interne de
 * l'API (`/internal/runtime-links/:runtimeId/proxy<path>`), qui la fait
 * transiter par le lien tenu par l'hôte. Le worker ne connaît alors ni URL ni
 * bearer du gateway, seulement son propre bearer interne.
 */
export type RuntimeClientContext = {
  runtimeId: string;
  reachability: "connector" | "direct";
  runtimeEndpoint: string | null;
  tokenCiphertext: string | null;
  tokenNonce: string | null;
  tokenTag: string | null;
  tokenKeyId: string | null;
  edgeAuthCiphertext?: string | null;
  edgeAuthNonce?: string | null;
  edgeAuthTag?: string | null;
  edgeAuthKeyId?: string | null;
  hermesProfile: string | null;
};

export type RuntimeClientConfig = Pick<
  WorkerConfig,
  "apiInternalUrl" | "internalSecrets" | "runtimeLinkInternalUrl"
> & Partial<Pick<WorkerConfig, "tokenEncryption" | "hermesEndpointPolicy" | "hermesMtls" | "hermesTimeouts">>;

/** En-tête posé par le relais quand la réponse décrit une panne du LIEN, pas une réponse gateway. */
export { RELAY_STAGE_HEADER };

export function createRuntimeClient(
  context: RuntimeClientContext,
  config: RuntimeClientConfig,
  fetchImpl: typeof fetch = fetch,
): HermesClient {
  if (context.reachability === "direct") {
    return new HermesClient({
      transport: createDirectTransport(directRuntimeCredentials(context, config)),
      profile: null,
      timeouts: config.hermesTimeouts,
    });
  }
  return new HermesClient({
    transport: createRelayTransport({
      runtimeId: context.runtimeId,
      dial: createWorkerRelayDialer(context.runtimeId, config, fetchImpl),
    }),
    profile: context.hermesProfile,
    timeouts: config.hermesTimeouts,
  });
}

/** L'URL du relais pour une requête gateway : préfixe interne + chemin tel quel (query comprise). */
export function relayProxyUrl(apiInternalUrl: string, runtimeId: string, path: string): string {
  return `${apiInternalUrl.replace(/\/+$/, "")}/internal/runtime-links/${encodeURIComponent(runtimeId)}/proxy${path}`;
}

/**
 * Le dialer du worker : une requête HTTP vers le relais, avec le bearer
 * interne. Une réponse marquée `X-OpenedBot-Relay-Stage` est une panne du lien,
 * rendue comme `RelayDialError` datée de son étape pour que le transport la
 * classe (`not_sent` / `ambiguous`). Sans marque, c'est la réponse du gateway.
 *
 * Dans le contexte de trace d'un run (`runWithTrace`, ouvert par le worker),
 * chaque requête part avec un `traceparent` neuf (même trace, span enfant) et
 * laisse une ligne `worker.relay_request` : le relais (`runtime_link.relay_request`)
 * et le connecteur (`relay … trace=… span=…`) journalisent le même couple.
 * Hors d'un run, rien n'est ajouté.
 */
export function createWorkerRelayDialer(
  runtimeId: string,
  config: Pick<RuntimeClientConfig, "apiInternalUrl" | "internalSecrets" | "runtimeLinkInternalUrl">,
  fetchImpl: typeof fetch = fetch,
): RelayDialer {
  return async (request: RelayRequest, signal?: AbortSignal): Promise<Response> => {
    const headers = new Headers(request.headers);
    headers.set("Authorization", internalBearer(config.internalSecrets, "relay"));
    const parent = currentTrace();
    const trace = parent ? childTraceContext(parent) : null;
    if (trace) headers.set(RELAY_TRACEPARENT_HEADER, formatTraceparent(trace));
    const startedAt = performance.now();
    const journal = (outcome: { status: number } | { error: string; stage?: RelayErrStage }) => {
      if (trace) logRelayRequest(runtimeId, request, trace, Math.round(performance.now() - startedAt), outcome);
    };
    let response: Response;
    try {
      response = await fetchImpl(relayProxyUrl(config.runtimeLinkInternalUrl ?? config.apiInternalUrl, runtimeId, request.path), {
        method: request.method,
        headers,
        body: request.body,
        signal,
        cache: "no-store",
        redirect: "manual",
        // Un corps en flux exige de déclarer le mode half-duplex.
        ...(request.body instanceof ReadableStream ? { duplex: "half" as const } : {}),
      } as RequestInit);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        journal({ error: "aborted" });
        throw error;
      }
      if (isConnectionRefused(error)) {
        journal({ error: "RELAY_UNREACHABLE", stage: "before_dispatch" });
        throw new RelayDialError("Le relais du lien connecteur est injoignable.", "before_dispatch", "RELAY_UNREACHABLE", { cause: error });
      }
      // Panne réseau à une étape inconnue : sans étape, le transport classe
      // une mutation `ambiguous` : on ne prétend pas que rien n'est parti.
      journal({ error: "RELAY_FAILED" });
      throw error;
    }
    const stage = relayStageOf(response.headers);
    if (stage === "before_dispatch" || stage === "after_dispatch") {
      const failure = await relayFailure(response, stage);
      journal({ error: failure.code ?? "LINK_FAILED", stage });
      throw failure;
    }
    journal({ status: response.status });
    return response;
  };
}

/**
 * La ligne du worker sur la piste d'un run : la route sans sa query (ni texte,
 * ni identifiant de session au-delà du chemin), l'issue et le couple trace/span.
 */
function logRelayRequest(
  runtimeId: string,
  request: RelayRequest,
  trace: TraceContext,
  durationMs: number,
  outcome: { status: number } | { error: string; stage?: RelayErrStage },
): void {
  logEvent("worker.relay_request", {
    runtimeId,
    method: request.method,
    path: request.path.split("?")[0],
    ...outcome,
    durationMs,
    traceId: trace.traceId,
    spanId: trace.spanId,
    parentSpanId: trace.parentSpanId,
  }, "error" in outcome ? "warn" : "info");
}

async function relayFailure(response: Response, stage: RelayErrStage): Promise<RelayDialError> {
  let code: string | null = null;
  let message = `Le relais du lien connecteur a répondu ${response.status}.`;
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Corps illisible : le statut et l'étape suffisent à classer la panne.
  }
  return new RelayDialError(message, stage, code);
}

function isConnectionRefused(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause && typeof cause === "object"; depth++) {
    const current = cause as { code?: unknown; cause?: unknown };
    if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ConnectionRefused"].includes(String(current.code))) return true;
    cause = current.cause;
  }
  return false;
}

/** Decrypted credentials exist only in the direct client's in-memory configuration. */
function directRuntimeCredentials(context: RuntimeClientContext, config: RuntimeClientConfig) {
  if (!config.tokenEncryption || !config.hermesEndpointPolicy || !context.runtimeEndpoint
    || !context.tokenCiphertext || !context.tokenNonce || !context.tokenTag) {
    throw new Error("Direct runtime credentials are unavailable.");
  }
  const token = decryptSecretFromKeyring({ ciphertext: context.tokenCiphertext, nonce: context.tokenNonce, tag: context.tokenTag }, context.tokenKeyId, config.tokenEncryption).value;
  let headers: Record<string, string> | undefined;
  if (context.edgeAuthCiphertext) {
    if (!context.edgeAuthNonce || !context.edgeAuthTag || !context.edgeAuthKeyId) throw new Error("Direct Access credentials are incomplete.");
    const value = decryptSecretFromKeyring({ ciphertext: context.edgeAuthCiphertext, nonce: context.edgeAuthNonce, tag: context.edgeAuthTag }, context.edgeAuthKeyId, config.tokenEncryption).value;
    const edge = JSON.parse(value);
    if (!edge || typeof edge.clientId !== "string" || typeof edge.clientSecret !== "string"
      || !edge.clientId || !edge.clientSecret || edge.clientId.length > 4096 || edge.clientSecret.length > 4096
      || /[\r\n\0]/.test(edge.clientId + edge.clientSecret)
      || Object.keys(edge).some((key) => !["clientId", "clientSecret"].includes(key))) throw new Error("Direct Access credentials are invalid.");
    headers = { "CF-Access-Client-Id": edge.clientId, "CF-Access-Client-Secret": edge.clientSecret };
  }
  return { endpoint: context.runtimeEndpoint, token, headers, policy: config.hermesEndpointPolicy, mtls: config.hermesMtls ?? null };
}
