import { checkServerIdentity } from "node:tls";
import {
  HermesEndpointError,
  pinHermesRequestUrl,
  resolveHermesDestination,
  type EndpointPolicy,
} from "../endpoint";
import { HermesClientError, requestAbortError } from "../errors";
import { hermesMtlsTlsOptions, type HermesMtlsIdentity } from "../mtls";
import type { HermesRequestKind, HermesTransport } from "./types";

export type HermesDirectTransportOptions = {
  endpoint: string;
  token: string;
  /** Only the two Cloudflare Access service-token headers are accepted. */
  headers?: Record<string, string>;
  policy: EndpointPolicy;
  /** null = bearer only; non-null = bearer plus mandatory client TLS identity. */
  mtls: HermesMtlsIdentity | null;
};

/**
 * Transport `direct` : une URL publique, un bearer, HTTPS.
 *
 * La destination est résolue et validée À CHAQUE requête (garde SSRF, DNS),
 * puis la requête est épinglée sur l'adresse validée : `Host` et le nom TLS
 * restent ceux de l'URL d'origine, si bien qu'aucune seconde résolution DNS,
 * potentiellement contrôlée par l'attaquant : ne s'intercale entre la
 * validation et la connexion.
 */
export function createDirectTransport(options: HermesDirectTransportOptions): HermesTransport {
  return {
    kind: "direct",
    async send(path: string, init: RequestInit, requestKind: HermesRequestKind): Promise<Response> {
      let destination;
      try {
        destination = await resolveHermesDestination(options.endpoint, options.policy);
      } catch (error) {
        if (error instanceof HermesEndpointError) {
          const status = error.code === "HERMES_URL_INVALID" || error.code === "HERMES_HTTPS_REQUIRED"
            ? 400
            : error.code === "HERMES_DESTINATION_FORBIDDEN"
              ? 403
              : 502;
          throw new HermesClientError(error.message, status, error.code, {
            requestDelivery: "not_sent",
            cause: error,
          });
        }
        throw error;
      }

      if (init.signal?.aborted) throw requestAbortError("not_sent", init.signal.reason);

      if (options.mtls && new URL(destination.endpoint).protocol !== "https:") {
        throw new HermesClientError(
          "Hermes mTLS exige une URL HTTPS.",
          400,
          "HERMES_HTTPS_REQUIRED",
          { requestDelivery: "not_sent" },
        );
      }

      const requestUrl = `${destination.endpoint.replace(/\/+$/, "")}${path}`;
      const pinned = pinHermesRequestUrl(requestUrl, destination);
      const headers = new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${options.token}`,
      });
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        if (!/^cf-access-client-(id|secret)$/i.test(name)) {
          throw new HermesClientError("En-tête Access invalide.", 400, "HERMES_URL_INVALID");
        }
        headers.set(name, value);
      }
      headers.set("Authorization", `Bearer ${options.token}`);
      headers.set("Host", pinned.hostHeader ?? new URL(destination.endpoint).host);

      const tls = options.mtls || pinned.tlsServerName
        ? {
            ...(options.mtls ? hermesMtlsTlsOptions(options.mtls) : {}),
            ...(pinned.tlsServerName
              ? {
                  serverName: pinned.tlsServerName,
                  checkServerIdentity: (
                    _hostname: string,
                    certificate: Parameters<typeof checkServerIdentity>[1],
                  ) => checkServerIdentity(pinned.tlsServerName!, certificate),
                }
              : {}),
          }
        : null;
      try {
        return await fetch(pinned.url, {
          ...init,
          cache: "no-store",
          redirect: "manual",
          // A pool keyed only by the pinned IP could otherwise reuse one TLS
          // connection across distinct virtual hosts and skip the next SNI/cert check.
          keepalive: pinned.tlsServerName ? false : init.keepalive,
          headers,
          ...(tls ? { tls } : {}),
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw requestAbortError("ambiguous", error);
        }
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        const tlsInvalid = message.includes("certificate") || message.includes("tls");
        throw new HermesClientError(
          tlsInvalid
            ? "Le certificat TLS du runtime Hermes est invalide."
            : "Le runtime Hermes est inaccessible.",
          502,
          tlsInvalid ? "HERMES_TLS_INVALID" : "HERMES_UNREACHABLE",
          {
            requestDelivery: tlsInvalid
              ? "not_sent"
              : requestKind === "mutation"
                ? "ambiguous"
                : null,
            cause: error,
          },
        );
      }
    },
  };
}
