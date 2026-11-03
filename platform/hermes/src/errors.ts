export type HermesClientErrorCode =
  | "HERMES_UNREACHABLE"
  | "HERMES_TLS_INVALID"
  | "HERMES_TOKEN_REJECTED"
  | "HERMES_PROFILE_MISSING"
  | "HERMES_RUN_MISSING"
  | "HERMES_LIMIT_REACHED"
  /**
   * Le gateway redémarre en douceur : il finit ses runs et refuse les
   * nouveaux (503 `gateway_draining`), AVANT d'en créer aucun.
   */
  | "HERMES_GATEWAY_DRAINING"
  | "HERMES_STREAM_INTERRUPTED"
  | "HERMES_PROTOCOL_LIMIT"
  | "HERMES_CREATE_AMBIGUOUS"
  | "HERMES_RESPONSE_INVALID"
  | "HERMES_URL_INVALID"
  | "HERMES_HTTPS_REQUIRED"
  | "HERMES_DESTINATION_FORBIDDEN"
  | "HERMES_DNS_FAILED"
  /** Le lien connecteur ne relaie pas cette route : refusée avant tout envoi. */
  | "HERMES_LINK_PATH_FORBIDDEN"
  | HermesProviderErrorCode;

/**
 * Codes rendus par les routes HÔTE `/hermes-setup/…` (contrat
 * docs/CONNECTOR.md). Ils viennent de l'hôte, pas du gateway, et forment un
 * jeu FERMÉ : un code inconnu retombe sur `HERMES_RESPONSE_INVALID`.
 *
 * Cette liste est le miroir de `probeRefusals` et des `writeError` de
 * `internal/operator/` côté `edge-setup`. Un code absent d'ici n'est pas
 * ignoré, il est écrasé : l'opérateur lirait alors « l'hôte a refusé »
 * là où l'hôte disait précisément quoi corriger. Les deux listes se
 * modifient ensemble.
 */
export type HermesProviderErrorCode =
  | "PROVIDER_INVALID"
  | "API_KEY_INVALID"
  /** Un dépôt de clé est déjà en cours pour ce fournisseur (un seul `hermes auth add` à la fois). */
  | "CREDENTIAL_IN_PROGRESS"
  | "OAUTH_SESSION_NOT_FOUND"
  | "OAUTH_IN_PROGRESS"
  | "RUNTIME_CATALOGUE_UNREADABLE"
  | "USAGE_PROBE_FAILED"
  | "USAGE_PROBE_TIMEOUT"
  /** Le socket de l'opérateur ne répond pas : rien n'a atteint l'hôte (`before_dispatch`). */
  | "HERMES_OPERATOR_UNAVAILABLE"
  // Verbes toolset.
  | "TOOLSET_INVALID"
  /** L'hôte ne porte pas ce toolset sur sa plateforme `api_server`. */
  | "TOOLSET_NOT_SETTABLE"
  /** Le contrat durable refuse ce toolset ; l'hôte le rejoue. */
  | "TOOLSET_FORBIDDEN"
  | "TOOLSET_IN_PROGRESS"
  /** L'écriture a eu lieu, l'inventaire n'a pas pu être relu : état inconnu. */
  | "TOOLSET_UNVERIFIED"
  // Verbes MCP.
  | "BODY_INVALID"
  | "NAME_INVALID"
  | "URL_INVALID"
  | "AUTH_INVALID"
  | "SECRET_INVALID"
  /** Le lien ne porte aucun exécutable vers l'hôte : un serveur stdio se refuse. */
  | "STDIO_REFUSED"
  | "TOKEN_REFUSED"
  | "SERVER_REFUSED"
  | "OAUTH_UNSUPPORTED"
  | "ENV_UNKNOWN"
  | "ENV_REQUIRED"
  | "SERVER_EXISTS"
  | "SERVER_UNKNOWN"
  | "MCP_SERVER_NOT_FOUND"
  | "MCP_IN_PROGRESS"
  | "CATALOG_ENTRY_UNKNOWN"
  | "CATALOG_UNAVAILABLE"
  | "INSTALL_FAILED"
  | "RESPONSE_TOO_LARGE"
  // OAuth MCP.
  | "REDIRECT_INVALID"
  /** L'hôte ne porte pas le programme d'autorisation : `mcp_oauth` n'est pas annoncé. */
  | "OAUTH_UNAVAILABLE"
  | "MCP_OAUTH_IN_PROGRESS"
  /** L'autorisation a déjà reçu son callback ; le programme n'en accepte qu'un. */
  | "OAUTH_CALLBACK_USED"
  // Redémarrage du gateway.
  | "GATEWAY_RESTART_UNAVAILABLE"
  | "GATEWAY_RESTART_NOT_FOUND"
  | "GATEWAY_RESTART_IN_PROGRESS"
  /** Refus générique de l'hôte : aucun texte upstream n'y est joint. */
  | "HOST_UNAVAILABLE"
  // Inventaire et gestion nommée des profils.
  | "PROFILE_INVALID"
  | "APPROVAL_POLICY_UNAVAILABLE"
  | "APPROVAL_POLICY_UNVERIFIED"
  | "PROFILE_EXISTS"
  | "PROFILE_UNVERIFIED"
  | "PROFILE_NOT_FOUND"
  | "MULTIPLEX_OFF"
  | "AVATAR_NOT_FOUND"
  | "AVATAR_TOO_LARGE"
  | "SKILL_INVALID"
  | "SKILL_NOT_FOUND"
  | "SKILL_IN_PROGRESS"
  | "SKILL_UNVERIFIED"
  | "PROVIDER_UNKNOWN"
  | "PROFILE_ENV_REFUSED"
  | "PROFILE_CONFIG_REFUSED"
  | "CREDENTIAL_MIRROR_FAILED"
  | "MEMORY_INVALID"
  | "MEMORY_DISABLED"
  | "MEMORY_REFUSED"
  | "MEMORY_UNAVAILABLE"
  | "MEMORY_IN_PROGRESS"
  | "SKILL_IDENTIFIER_INVALID"
  | "SKILL_QUERY_INVALID"
  | "SKILL_SOURCE_INVALID"
  | "SKILL_OPERATION_IN_PROGRESS"
  | "SKILL_SCAN_BLOCKED"
  | "SKILL_TRUST_REFUSED"
  | "SKILL_INSTALL_UNVERIFIED"
  | "OPERATION_INTERRUPTED";

export const HERMES_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set<HermesProviderErrorCode>([
  "PROVIDER_INVALID",
  "API_KEY_INVALID",
  "CREDENTIAL_IN_PROGRESS",
  "OAUTH_SESSION_NOT_FOUND",
  "OAUTH_IN_PROGRESS",
  "RUNTIME_CATALOGUE_UNREADABLE",
  "USAGE_PROBE_FAILED",
  "USAGE_PROBE_TIMEOUT",
  "HERMES_OPERATOR_UNAVAILABLE",
  "TOOLSET_INVALID",
  "TOOLSET_NOT_SETTABLE",
  "TOOLSET_FORBIDDEN",
  "TOOLSET_IN_PROGRESS",
  "TOOLSET_UNVERIFIED",
  "BODY_INVALID",
  "NAME_INVALID",
  "URL_INVALID",
  "AUTH_INVALID",
  "SECRET_INVALID",
  "STDIO_REFUSED",
  "TOKEN_REFUSED",
  "SERVER_REFUSED",
  "OAUTH_UNSUPPORTED",
  "ENV_UNKNOWN",
  "ENV_REQUIRED",
  "SERVER_EXISTS",
  "SERVER_UNKNOWN",
  "MCP_SERVER_NOT_FOUND",
  "MCP_IN_PROGRESS",
  "CATALOG_ENTRY_UNKNOWN",
  "CATALOG_UNAVAILABLE",
  "INSTALL_FAILED",
  "RESPONSE_TOO_LARGE",
  "REDIRECT_INVALID",
  "OAUTH_UNAVAILABLE",
  "MCP_OAUTH_IN_PROGRESS",
  "OAUTH_CALLBACK_USED",
  "GATEWAY_RESTART_UNAVAILABLE",
  "GATEWAY_RESTART_NOT_FOUND",
  "GATEWAY_RESTART_IN_PROGRESS",
  "HOST_UNAVAILABLE",
  "PROFILE_INVALID",
  "APPROVAL_POLICY_UNAVAILABLE",
  "APPROVAL_POLICY_UNVERIFIED",
  "PROFILE_EXISTS",
  "PROFILE_UNVERIFIED",
  "PROFILE_NOT_FOUND",
  "MULTIPLEX_OFF",
  "AVATAR_NOT_FOUND",
  "AVATAR_TOO_LARGE",
  "SKILL_INVALID",
  "SKILL_NOT_FOUND",
  "SKILL_IN_PROGRESS",
  "SKILL_UNVERIFIED",
  "PROVIDER_UNKNOWN",
  "PROFILE_ENV_REFUSED",
  "PROFILE_CONFIG_REFUSED",
  "CREDENTIAL_MIRROR_FAILED",
  "MEMORY_INVALID",
  "MEMORY_DISABLED",
  "MEMORY_REFUSED",
  "MEMORY_UNAVAILABLE",
  "MEMORY_IN_PROGRESS",
  "SKILL_IDENTIFIER_INVALID",
  "SKILL_QUERY_INVALID",
  "SKILL_SOURCE_INVALID",
  "SKILL_OPERATION_IN_PROGRESS",
  "SKILL_SCAN_BLOCKED",
  "SKILL_TRUST_REFUSED",
  "SKILL_INSTALL_UNVERIFIED",
  "OPERATION_INTERRUPTED",
]);

export function isHermesProviderErrorCode(value: unknown): value is HermesProviderErrorCode {
  return typeof value === "string" && HERMES_PROVIDER_ERROR_CODES.has(value);
}

/** Certitude disponible après une erreur de transport. */
export type HermesRequestDelivery = "not_sent" | "ambiguous" | "response_received";

export type HermesClientErrorOptions = {
  requestDelivery?: HermesRequestDelivery | null;
  retryAfterMs?: number | null;
  /** Corps upstream brut, réservé au JOURNAL de l'opérateur : jamais persisté ni affiché. */
  diagnostic?: string | null;
  /** Référence courte imprimée dans `message` ET dans le journal, pour corréler les deux. */
  reference?: string | null;
  cause?: unknown;
};

/**
 * Deux publics, deux champs. `message` est une phrase destinée à l'humain qui
 * lit un fil, un toast ou un écran de réglages : elle ne porte ni JSON, ni
 * identifiant interne. `diagnostic` porte temporairement l'extrait upstream
 * afin de calculer et propager une référence d'incident. Il ne doit être ni
 * renvoyé, ni persisté, ni journalisé : le runtime peut y inclure un secret ou
 * du contenu privé. `reference` est le seul champ sûr pour relier les surfaces.
 */
export class HermesClientError extends Error {
  readonly requestDelivery: HermesRequestDelivery | null;
  readonly retryAfterMs: number | null;
  readonly diagnostic: string | null;
  readonly reference: string | null;

  constructor(
    message: string,
    readonly status: number,
    readonly code: HermesClientErrorCode,
    options: HermesClientErrorOptions = {},
  ) {
    super(message);
    this.name = "HermesClientError";
    this.requestDelivery = options.requestDelivery ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.diagnostic = options.diagnostic ?? null;
    this.reference = options.reference ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Un `AbortError` annoté de la certitude de livraison : le transport sait si
 * l'annulation est survenue avant tout envoi ou pendant, et l'appelant en tire
 * un message et un code différents.
 */
export type HermesAbortError = DOMException & {
  requestDelivery: "not_sent" | "ambiguous";
  cause?: unknown;
};

export function requestAbortError(
  requestDelivery: HermesAbortError["requestDelivery"],
  cause: unknown,
): HermesAbortError {
  const error = new DOMException("La requête Hermes a été annulée.", "AbortError") as HermesAbortError;
  error.requestDelivery = requestDelivery;
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function abortedRequestDelivery(error: Error): HermesAbortError["requestDelivery"] {
  const candidate = error as Partial<HermesAbortError>;
  return candidate.requestDelivery === "not_sent" ? "not_sent" : "ambiguous";
}
