/**
 * Ce qu'une requête demande au transport, pour classer une panne.
 *
 * Une `mutation` (POST /v1/runs, /stop, /steer, /approval, /api/sessions)
 * qui échoue après un envoi possible est `ambiguous` : Hermes a peut-être agi.
 * Une lecture `safe` rejouée ne coûte rien, donc sa certitude reste `null`.
 */
export type HermesRequestKind = "safe" | "mutation";

/**
 * Le seul point de contact entre `HermesClient` et le réseau.
 *
 * `direct` compose une URL publique et parle HTTPS ; `relay` pousse la même
 * requête dans le lien connecteur, sans jamais connaître d'adresse. Dans les
 * deux cas `path` inclut déjà le préfixe `/p/<slug>` et la query, `init`
 * porte méthode, en-têtes, corps et signal, et la réponse est retournée telle
 * quelle, corps en flux.
 */
export type HermesTransport = {
  readonly kind: "direct" | "relay";
  send(path: string, init: RequestInit, kind: HermesRequestKind): Promise<Response>;
};
