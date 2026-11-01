import { MAX_ERROR_BODY_BYTES, MAX_INVENTORY_BODY_BYTES, MAX_PROVIDER_BODY_BYTES } from "../contracts";
import type { HermesClientConfig, HermesClientTimeouts } from "../contracts";
import { hermesProfilePath } from "../endpoint";
import { HermesClientError, type HermesClientErrorOptions } from "../errors";
import {
  diagnosticReference as diagnosticReferenceParser,
  parseRetryAfter as parseRetryAfterHeader,
  providerErrorFromBody as providerError,
  readBoundedJson as readBoundedJsonParser,
  readResponseExcerpt as readResponseExcerptParser,
  upstreamDiagnostic as parseUpstreamDiagnostic,
} from "../parsers";
import { invalidProviderResponse } from "../parsers/shared";
import type { HermesRequestKind, HermesTransport } from "../transport/types";
import { recordResponseEvidence } from "./evidence";

/**
 * What every surface function (`./runs`, `./sessions`, ...) needs from the
 * client: the one network exit and the shared response handling. A
 * `HermesClient` builds exactly one and hands it to the functions it delegates
 * to, so the surfaces never import the class.
 */
export type HermesClientContext = {
  /** The Hermes profile the client addresses, if any (`/p/<slug>` prefix). */
  readonly profile: string | null | undefined;
  readonly timeouts: HermesClientTimeouts;
  /** A context for the same endpoint and credentials under another profile. */
  withProfile(profile: string | null): HermesClientContext;
  /**
   * Le seul point de sortie réseau du client. Le transport reçoit le chemin
   * complet (profil compris), la requête et sa nature, et rend la réponse ou
   * lève une `HermesClientError` déjà classée par certitude de livraison.
   */
  fetch(path: string, init?: RequestInit, requestKind?: HermesRequestKind): Promise<Response>;
  json(path: string, options: { timeoutMs: number; maxBytes?: number }): Promise<unknown>;
  /** `null` UNIQUEMENT sur 404 : l'endpoint n'existe pas sur ce build. */
  optionalJson(path: string): Promise<unknown | null>;
  timedMutation(path: string, init: RequestInit): Promise<Response>;
  throwResponse(response: Response, options?: { profileMissingOn404?: boolean }): Promise<never>;
  /**
   * Une requête vers une route HÔTE `/hermes-setup/…`, toujours à la RACINE
   * du runtime : un credential vaut pour tout le runtime, pas pour un profil.
   * Le préfixe `/p/<slug>` du client est donc retiré ici, jamais interpolé.
   */
  hostRequest(path: string, init: RequestInit, kind: HermesRequestKind, timeoutMs: number): Promise<Response>;
  providerJson(response: Response): Promise<unknown>;
  /**
   * Une réponse non-2xx d'une route hôte : `{error:{code,message}}` du
   * contrat, rendue avec son statut et son code ; toute autre forme retombe
   * sur un refus générique, sans corps upstream dans le message.
   */
  throwProviderResponse(response: Response): Promise<never>;
};

export function createHermesClientContext(options: {
  config: HermesClientConfig;
  transport: HermesTransport;
  timeouts: HermesClientTimeouts;
  withProfile: (profile: string | null) => HermesClientContext;
}): HermesClientContext {
  const { config, transport, timeouts } = options;

  /** Le chemin tel que le transport le reçoit : préfixe `/p/<slug>` compris. */
  function path(path: string): string {
    return config.profile ? `${hermesProfilePath(config.profile)}${path}` : path;
  }

  function send(
    requestPath: string,
    init: RequestInit = {},
    requestKind: HermesRequestKind = "safe",
  ): Promise<Response> {
    return transport.send(path(requestPath), init, requestKind);
  }

  async function throwResponse(
    response: Response,
    errorOptions: { profileMissingOn404?: boolean } = {},
  ): Promise<never> {
    const text = await readResponseExcerptParser(response, MAX_ERROR_BODY_BYTES);
    try {
      const retryAfterMs = parseRetryAfterHeader(response.headers.get("Retry-After"));
      // L'extrait upstream reste CAPTURÉ (un 400 gateway opaque est indéboguable
      // sans lui), mais il quitte `message` : mesuré le 25-08, un fil affichait
      // « Title already in use by session ohb:<org>:workflow:<id>:bot:<id> »,
      // c'est-à-dire du JSON machine et des identifiants internes, à l'utilisateur.
      const diagnostic = parseUpstreamDiagnostic(text);
      const reference = diagnostic ? diagnosticReferenceParser(response.status, diagnostic) : null;
      const clientErrorOptions: HermesClientErrorOptions = {
        requestDelivery: "response_received",
        retryAfterMs,
        diagnostic,
        reference,
      };
      const suffix = reference ? ` (réf. ${reference})` : "";
      if (response.status === 401 || response.status === 403) {
        throw new HermesClientError(
          `Le token Hermes a été refusé.${suffix}`,
          response.status,
          "HERMES_TOKEN_REJECTED",
          clientErrorOptions,
        );
      }
      if (response.status === 404 && config.profile && errorOptions.profileMissingOn404 !== false) {
        throw new HermesClientError(
          `Le profil Hermes est introuvable.${suffix}`,
          404,
          "HERMES_PROFILE_MISSING",
          clientErrorOptions,
        );
      }
      if (response.status === 503 && upstreamErrorCode(text) === "gateway_draining") {
        throw new HermesClientError(
          `Le gateway Hermes redémarre : il finit ses runs en cours avant d'en accepter de nouveaux.${suffix}`,
          503,
          "HERMES_GATEWAY_DRAINING",
          clientErrorOptions,
        );
      }
      if (response.status === 429) {
        throw new HermesClientError(
          `Hermes a atteint sa limite de runs simultanés.${suffix}`,
          429,
          "HERMES_LIMIT_REACHED",
          clientErrorOptions,
        );
      }
      throw new HermesClientError(
        `Hermes a refusé la requête (HTTP ${response.status}).${suffix} Le détail technique est dans le journal du worker.`,
        response.status,
        "HERMES_RESPONSE_INVALID",
        clientErrorOptions,
      );
    } catch (error) {
      if (error instanceof Error) recordResponseEvidence(error, response, text);
      throw error;
    }
  }

  async function json(requestPath: string, jsonOptions: { timeoutMs: number; maxBytes?: number }): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), jsonOptions.timeoutMs);
    try {
      const response = await send(requestPath, { signal: controller.signal });
      if (!response.ok) await throwResponse(response);
      try {
        return jsonOptions.maxBytes
          ? await readBoundedJsonParser(response, jsonOptions.maxBytes)
          : await response.json();
      } catch (error) {
        if (error instanceof HermesClientError) {
          recordResponseEvidence(error, response);
          throw error;
        }
        const invalid = new HermesClientError(
          "Hermes a renvoyé une réponse JSON invalide.",
          502,
          "HERMES_RESPONSE_INVALID",
          { requestDelivery: "response_received", cause: error },
        );
        recordResponseEvidence(invalid, response);
        throw invalid;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function optionalJson(requestPath: string): Promise<unknown | null> {
    try {
      return await json(requestPath, { timeoutMs: 8_000, maxBytes: MAX_INVENTORY_BODY_BYTES });
    } catch (error) {
      if (error instanceof HermesClientError && error.status === 404) return null;
      throw error;
    }
  }

  async function timedMutation(requestPath: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("mutation_timeout"), timeouts.mutationMs);
    const source = init.signal;
    const abort = () => controller.abort(source?.reason ?? "mutation_aborted");
    if (source?.aborted) abort();
    else source?.addEventListener("abort", abort, { once: true });
    try {
      return await send(requestPath, { ...init, signal: controller.signal }, "mutation");
    } finally {
      clearTimeout(timeout);
      source?.removeEventListener("abort", abort);
    }
  }

  async function providerJson(response: Response): Promise<unknown> {
    try {
      return await readBoundedJsonParser(response, MAX_PROVIDER_BODY_BYTES);
    } catch (error) {
      if (error instanceof HermesClientError) throw error;
      throw invalidProviderResponse(error);
    }
  }

  async function throwProviderResponse(response: Response): Promise<never> {
    const text = await readResponseExcerptParser(response, MAX_ERROR_BODY_BYTES);
    let body: unknown = null;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
    throw providerError(body, response.status);
  }

  async function hostRequest(
    requestPath: string,
    init: RequestInit,
    kind: HermesRequestKind,
    timeoutMs: number,
  ): Promise<Response> {
    const rootClient = config.profile ? options.withProfile(null) : context;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("host_route_timeout"), timeoutMs);
    try {
      return await rootClient.fetch(requestPath, { ...init, signal: controller.signal }, kind);
    } finally {
      clearTimeout(timeout);
    }
  }

  const context: HermesClientContext = {
    profile: config.profile,
    timeouts,
    withProfile: options.withProfile,
    fetch: send,
    json,
    optionalJson,
    timedMutation,
    throwResponse,
    hostRequest,
    providerJson,
    throwProviderResponse,
  };
  return context;
}

/** Le `error.code` d'une enveloppe d'erreur OpenAI du gateway, ou `null`. */
function upstreamErrorCode(text: string): string | null {
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown } } | null;
    const code = body?.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}
