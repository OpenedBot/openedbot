/**
 * Les routes que le lien connecteur relaie, et rien d'autre.
 *
 * Liste FIGÉE, identique à `internal/connector/allowlist.go` côté
 * `edge-setup` : un chemin hors liste est refusé des deux côtés, avant de
 * toucher le loopback. Deux familles :
 *
 *   - les routes GATEWAY (`host: false`), dispatchées au loopback Hermes ;
 *   - les routes HÔTE `/hermes-setup/…` (`host: true`) : la sonde
 *     `GET /hermes-setup/capabilities`, les verbes fournisseur, profil,
 *     toolset et MCP, servies par le connecteur lui-même, jamais par
 *     le gateway.
 *
 * Les écritures possibles sur l'hôte se comptent : déposer une clé API, ouvrir
 * une session OAuth par code d'appareil, activer ou désactiver un toolset,
 * ajouter ou retirer un serveur MCP, installer une entrée du catalogue
 * approuvé, autoriser un serveur MCP OAuth (l'URL sort, le callback
 * `code`+`state` revient), et redémarrer le gateway. Chacune ne nomme qu'un
 * slug fournisseur, une clé de toolset, un nom de serveur ou un identifiant de
 * session ; aucun shell, aucun chemin de fichier, aucune commande, aucun verbe
 * exec/update ne transite par le lien, dans aucun sens.
 *
 * Le redémarrage du gateway est le SEUL redémarrage que le lien porte : route
 * fixe, unité fixe sur l'hôte (`hermes-gateway`), aucun argument, prouvé sur
 * `/health` par l'hôte. Il existe parce que le gateway ne lit ses serveurs
 * MCP qu'au démarrage : sans lui, chaque écriture MCP ci-dessus resterait
 * invisible aux runs (`docs/CONNECTOR.md` de edge-setup, « Redémarrage du
 * gateway par le lien »).
 */

export type RelayRoute = {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: RegExp;
  /** La route SSE, exemptée du délai de première réponse. */
  readonly events: boolean;
  /** Servie par le connecteur sur l'hôte (routes fournisseur), jamais par le gateway. */
  readonly host: boolean;
  /** Route hôte qui refuse le préfixe optionnel `/p/<slug>`. */
  readonly rootOnly?: boolean;
  readonly noQuery?: boolean;
  /** Query string stricte. L'absence de query reste autorisée. */
  readonly query?: RegExp;
};

const ID_SEGMENT = "[A-Za-z0-9._~-]{1,128}";
/** Slug fournisseur Hermes : `^[a-z0-9][a-z0-9_-]{0,63}$`. */
const PROVIDER_SEGMENT = "[a-z0-9][a-z0-9_-]{0,63}";
/** Clé de toolset Hermes : minuscules et soulignés, jamais de tiret. */
const TOOLSET_SEGMENT = "[a-z0-9][a-z0-9_]{0,63}";
/** Nom de serveur MCP ou d'entrée du catalogue : l'amont y admet les majuscules. */
const MCP_SEGMENT = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";
/** Identifiant de session OAuth, même grammaire qu'un identifiant de run. */
const OAUTH_SESSION_SEGMENT = ID_SEGMENT;
/** Slug de profil Hermes : même grammaire que le préfixe `/p/<slug>`. */
const PROFILE_SEGMENT = "[a-z0-9][a-z0-9_-]{0,62}";
/** Skill Hermes : même borne qu'un toolset, plus le tiret (`hermes-agent`). */
const SKILL_SEGMENT = "[a-z0-9][a-z0-9_-]{0,63}";
const UUID_SEGMENT = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const A2A_PEER_SEGMENT = "[a-z0-9][a-z0-9._-]{0,63}";
/**
 * Identifiant de session Hermes : la grammaire d'un run, PLUS le deux-points.
 *
 * TOUTES les sessions qu'openedbot ouvre s'appellent `ohb:<org>:<...>` : la clé
 * porte le deux-points, et `encodeURIComponent` l'écrit `%3A` dans le chemin.
 * `ID_SEGMENT` ne connaît ni l'un ni l'autre. Une allowlist bâtie sur lui
 * refuse donc, avant même l'aller réseau, chacune des trois routes de session
 * pour le seul nom qu'openedbot sache produire.
 *
 * `%3A` est le SEUL échappement admis : ni `%2F`, ni `%2E`, ni un `%` nu ne
 * franchissent la liste, et la borne de longueur reste. Le déguisement d'un
 * `/` ou d'un `..` en pourcentage, qui deviendrait un chemin une fois décodé
 * par le gateway, reste donc impossible.
 *
 * 256 : la plus longue clé (`ohb:<uuid>:workflow:<uuid>:bot:<uuid>`) fait 127
 * caractères, 137 une fois ses cinq deux-points échappés.
 */
const HERMES_SESSION_SEGMENT = "(?:[A-Za-z0-9._~-]|%3[Aa]){1,256}";

function route(
  method: RelayRoute["method"],
  pattern: string,
  options: { events?: boolean; host?: boolean; rootOnly?: boolean; noQuery?: boolean; query?: RegExp } = {},
): RelayRoute {
  return Object.freeze({
    method,
    path: new RegExp(pattern),
    events: options.events ?? false,
    host: options.host ?? false,
    ...(options.rootOnly ? { rootOnly: true } : {}),
    ...(options.noQuery ? { noQuery: true } : {}),
    ...(options.query ? { query: options.query } : {}),
  });
}

export const RELAY_ALLOWLIST: ReadonlyArray<RelayRoute> = Object.freeze([
  route("GET", "^/health$"),
  route("GET", "^/v1/capabilities$"),
  route("GET", "^/v1/models$"),
  route("GET", "^/v1/toolsets$"),
  route("GET", "^/v1/skills$"),
  route("GET", "^/api/model/options$"),
  route("GET", "^/api/mcp/servers$"),
  route("POST", "^/api/sessions$"),
  route("GET", `^/api/sessions/${HERMES_SESSION_SEGMENT}$`),
  route("GET", `^/api/sessions/${HERMES_SESSION_SEGMENT}/messages$`),
  // La seule écriture destructive du lien côté gateway : effacer une session
  // qu'openedbot y a créée, quand l'opérateur purge le bot qui la portait. Elle ne
  // peut viser qu'un identifiant `ohb:<org>:<thread>`, le seul nom connu
  // d'openedbot, et ne touche ni le profil, ni l'hôte.
  route("DELETE", `^/api/sessions/${HERMES_SESSION_SEGMENT}$`),
  route("POST", "^/v1/runs$"),
  route("GET", `^/v1/runs/${ID_SEGMENT}$`),
  route("GET", `^/v1/runs/${ID_SEGMENT}/events$`, { events: true }),
  route("POST", `^/v1/runs/${ID_SEGMENT}/(stop|steer|approval)$`),
  // Routes hôte (docs/CONNECTOR.md, « Fournisseurs par le lien »).
  route("GET", "^/hermes-setup/capabilities$", { host: true }),
  route("GET", "^/hermes-setup/usage$", { host: true }),
  // La fenêtre de contexte du modèle configuré. Le gateway ne la publie
  // nulle part : ni `/v1/models`, ni `/api/model/options`, ni
  // `/v1/capabilities`. L'amont la résout dans
  // `agent/model_metadata.py` et ne la sert que sur le Dashboard du CLI,
  // hors du lien. Lecture seule, un slug de profil pour seul argument.
  route("GET", "^/hermes-setup/model-context$", { host: true }),
  // Read-only report of SDK import availability in the gateway Python.
  route("GET", "^/hermes-setup/provider-sdks$", { host: true }),
  route("POST", `^/hermes-setup/providers/${PROVIDER_SEGMENT}/credentials$`, { host: true }),
  route("POST", `^/hermes-setup/providers/${PROVIDER_SEGMENT}/oauth$`, { host: true }),
  route("GET", `^/hermes-setup/providers/${PROVIDER_SEGMENT}/oauth/${OAUTH_SESSION_SEGMENT}$`, { host: true }),
  route("DELETE", `^/hermes-setup/providers/${PROVIDER_SEGMENT}/oauth/${OAUTH_SESSION_SEGMENT}$`, { host: true }),
  // Routes hôte : les verbes toolset et MCP, ce qui permet d'administrer la
  // surface de capacités du runtime depuis openedbot plutôt que depuis une console
  // sur l'hôte. Chacune nomme une clé de toolset, un serveur MCP ou une entrée
  // de catalogue, jamais une commande, un chemin ni un shell.
  route("GET", "^/hermes-setup/toolsets$", { host: true }),
  route("POST", `^/hermes-setup/toolsets/${TOOLSET_SEGMENT}$`, { host: true }),
  route("GET", "^/hermes-setup/mcp/servers$", { host: true }),
  route("POST", "^/hermes-setup/mcp/servers$", { host: true }),
  route("DELETE", `^/hermes-setup/mcp/servers/${MCP_SEGMENT}$`, { host: true }),
  route("POST", `^/hermes-setup/mcp/catalog/${MCP_SEGMENT}$`, { host: true }),
  // Routes hôte : l'OAuth d'un serveur MCP. Un serveur `auth: oauth` est
  // inerte tant qu'un navigateur ne l'a pas autorisé, et l'hôte n'en a pas :
  // l'URL d'autorisation sort par ici, le callback du fournisseur y revient.
  // Le callback nomme le serveur, pas la session : l'URL de retour est
  // enregistrée auprès du fournisseur avant qu'une session existe.
  route("POST", `^/hermes-setup/mcp/servers/${MCP_SEGMENT}/oauth$`, { host: true }),
  route("GET", `^/hermes-setup/mcp/servers/${MCP_SEGMENT}/oauth/${OAUTH_SESSION_SEGMENT}$`, { host: true }),
  route("POST", `^/hermes-setup/mcp/servers/${MCP_SEGMENT}/oauth/callback$`, { host: true }),
  route("DELETE", `^/hermes-setup/mcp/servers/${MCP_SEGMENT}/oauth/${OAUTH_SESSION_SEGMENT}$`, { host: true }),
  // Routes hôte : l'état du gateway, et le seul redémarrage que le lien porte.
  route("GET", "^/hermes-setup/gateway$", { host: true }),
  route("POST", "^/hermes-setup/gateway/restart$", { host: true }),
  route("GET", `^/hermes-setup/gateway/restart/${OAUTH_SESSION_SEGMENT}$`, { host: true }),
  // Routes hôte : la gestion nommée des profils Hermes et leur inventaire.
  // Le slug a la même grammaire que le préfixe `/p/<slug>`. Les mutations
  // restent bornées à un nom de profil, un toolset ou un serveur MCP : pas de
  // .env, mémoire, session, commande ni chemin de fichier.
  route("GET", "^/hermes-setup/profiles$", { host: true }),
  route("POST", "^/hermes-setup/profiles$", { host: true }),
  route("DELETE", `^/hermes-setup/profiles/${PROFILE_SEGMENT}$`, { host: true }),
  route("POST", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/toolsets/${TOOLSET_SEGMENT}$`, { host: true }),
  // La mémoire du profil (MEMORY.md / USER.md) par le magasin amont : une
  // lecture, et une écriture nommée par action (add / replace / remove).
  route("GET", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/memory$`, { host: true }),
  route("POST", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/memory$`, { host: true }),
  route("POST", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/model$`, { host: true }),
  // Un même modèle écrit dans plusieurs profils (feature `profile_model_batch`) ;
  // les noms de profil voyagent dans le corps, chacun vérifié par l'hôte.
  route("POST", "^/hermes-setup/profiles/models$", { host: true }),
  route("GET", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/approval-policy$`, { host: true }),
  route("PUT", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/approval-policy$`, { host: true }),
  route("POST", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/mcp/servers/${MCP_SEGMENT}$`, { host: true }),
  route("DELETE", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/mcp/servers/${MCP_SEGMENT}$`, { host: true }),
  route("POST", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/skills/${SKILL_SEGMENT}$`, { host: true }),
  route("POST", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/bundled-skills$`, { host: true }),
  route("POST", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/providers/${PROVIDER_SEGMENT}/credentials$`, { host: true }),
  route("DELETE", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/providers/${PROVIDER_SEGMENT}/credentials$`, { host: true }),
  route("POST", "^/hermes-setup/skills/hub/search$", { host: true }),
  route("POST", "^/hermes-setup/skills/hub/inspect$", { host: true }),
  route("POST", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/skills/hub/scan$`, { host: true }),
  route("POST", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/skills/hub/install$`, { host: true }),
  route("GET", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/skills/hub/operations/${UUID_SEGMENT}$`, { host: true }),
  route("DELETE", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/skills/${SKILL_SEGMENT}$`, { host: true }),
  route("GET", `^/hermes-setup/profiles/${PROFILE_SEGMENT}/avatar$`, { host: true }),
  // Route hôte : l'inventaire borné des sessions (identifiant, profil, date de
  // début), que le worker recoupe avec ses propres dispatches pour repérer un
  // run créé hors du lien. Jamais un message, jamais un chemin.
  route("GET", "^/hermes-setup/sessions-inventory$", { host: true }),
  // Read only the pinned A2A Agent Card through the host operator. The host
  // always targets its fixed loopback listener; no URL or path crosses the link.
  route("GET", "^/hermes-setup/a2a/agent-card$", { host: true }),
  // Read only the bounded A2A host audit projection. Query validation belongs
  // to the named host handler; the relay only forwards this fixed path.
  route("GET", "^/hermes-setup/a2a/audit$", {
    host: true,
    rootOnly: true,
    query: /^limit=([1-9]|[1-9][0-9]|100)$/,
  }),
  route("GET", "^/hermes-setup/a2a/peers$", { host: true, rootOnly: true, noQuery: true }),
  route("POST", `^/hermes-setup/a2a/peers/${A2A_PEER_SEGMENT}/trust$`, { host: true, rootOnly: true, noQuery: true }),
  route("POST", `^/hermes-setup/a2a/peers/${A2A_PEER_SEGMENT}/token$`, { host: true, rootOnly: true, noQuery: true }),
  route("DELETE", `^/hermes-setup/a2a/peers/${A2A_PEER_SEGMENT}/token$`, { host: true, rootOnly: true, noQuery: true }),
]);

/**
 * Préfixe optionnel `/p/<slug>`, même grammaire de slug que les profils Hermes.
 * Sur une route hôte il est accepté et ignoré : un credential vaut pour tout
 * le runtime, pas pour un profil.
 */
const PROFILE_PREFIX = /^\/p\/[a-z0-9][a-z0-9_-]{0,62}/;

/**
 * La route autorisée pour `method` + `path`, ou `null`. Un chemin qui contient
 * `..` ou `//`, ou qui ne commence pas par `/`, est refusé avant la liste.
 * Certaines routes valident aussi une query précise ou refusent le préfixe
 * optionnel `/p/<slug>`.
 */
export function matchRelayRoute(method: string, path: string): RelayRoute | null {
  let candidate = path;
  const query = candidate.indexOf("?");
  let queryString: string | undefined;
  if (query >= 0) {
    queryString = candidate.slice(query + 1);
    candidate = candidate.slice(0, query);
  }
  if (candidate.includes("..") || candidate.includes("//") || !candidate.startsWith("/")) return null;
  const prefix = PROFILE_PREFIX.exec(candidate);
  if (prefix) {
    candidate = candidate.slice(prefix[0].length);
    if (candidate === "") return null;
  }
  const upper = method.toUpperCase();
  for (const entry of RELAY_ALLOWLIST) {
    if (entry.method !== upper || !entry.path.test(candidate)) continue;
    if (entry.rootOnly && prefix) continue;
    if (entry.noQuery && queryString !== undefined) continue;
    if (queryString !== undefined && entry.query && !entry.query.test(queryString)) continue;
    return entry;
  }
  return null;
}

/** Les seuls en-têtes de requête relayés vers le gateway ; le bearer est ajouté sur l'hôte. */
export const RELAY_FORWARDED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  // `cache-control: no-cache` : « Actualiser » sur les limites fournisseur
  // contourne le cache d'une minute de l'opérateur hôte (usage.go).
  "cache-control",
  "content-type",
  "idempotency-key",
  "last-event-id",
]);

/** Les seuls en-têtes de réponse relayés vers openedbot. */
export const RELAY_FORWARDED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "retry-after",
]);
