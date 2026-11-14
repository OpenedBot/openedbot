import { createHash } from "node:crypto";
import {
  MAX_INVENTORY_BODY_BYTES,
  PROVIDER_POLL_TIMEOUT_MS,
  HOST_CAPABILITIES_TIMEOUT_MS,
  TOOLSET_MUTATION_TIMEOUT_MS,
  type HermesModelOptions,
  type HermesToolset,
  type HermesProfileIsolation,
  type HermesCapabilityInventory,
  type HermesConnectorManagementProbe,
  type HermesHostToolsets,
  type HermesProviderSdk,
  type HermesToolsetState,
  type HermesBrowserControlTransportProbe,
} from "../contracts";
import { HermesClientError } from "../errors";
import {
  normalizeHermesBrowserControlTransport as parseBrowserControlTransport,
  normalizeHermesModelOptions as parseModelOptions,
  normalizeHermesSkills as parseSkills,
  normalizeHermesToolsets as parseToolsets,
  parseHostCapabilities as parseHostCapabilitiesResponse,
  parseHostProviderSdks as parseHostProviderSdksResponse,
  parseHostToolsets as parseHostToolsetsResponse,
  parseToolsetState as parseToolsetStateResponse,
  readBoundedJson as readBoundedJsonParser,
} from "../parsers";
import { record } from "../parsers/shared";
import {
  readCachedEventReplay,
  readCachedToolsetInventory,
  rememberCachedEventReplay,
  rememberCachedToolsetInventory,
  type HermesPreflightScope,
  type HermesToolsetInventoryScope,
} from "../preflight-cache";
import type { HermesClientContext } from "./context";

function sessionFingerprint(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

function browserControlNotReported(): HermesBrowserControlTransportProbe {
  return {
    status: "not_reported",
    reason: "FEATURE_NOT_ADVERTISED",
    protocolVersion: null,
    capabilities: [],
    controllerBindingProven: false,
  };
}

export async function health(ctx: HermesClientContext): Promise<unknown> {
  return boundedProbeJson(ctx, "/health", 64 * 1024);
}

export async function capabilities(ctx: HermesClientContext): Promise<unknown> {
  return boundedProbeJson(ctx, "/v1/capabilities", 256 * 1024);
}

/** Bound the whole probe, including DNS. The inner signal still prevents a late send. */
async function boundedProbeJson(ctx: HermesClientContext, path: string, maxBytes: number): Promise<unknown> {
  const operation = ctx.json(path, { timeoutMs: 10_000, maxBytes });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new HermesClientError("La sonde Hermes a dépassé son délai.", 504, "HERMES_UNREACHABLE")), 10_000);
    })]);
  } finally { clearTimeout(timeout); }
}

export async function probe(ctx: HermesClientContext): Promise<{ health: unknown; capabilities: unknown }> {
  const [health, capabilities] = await Promise.all([
    ctx.json("/health", { timeoutMs: 5_000 }),
    ctx.json("/v1/capabilities", { timeoutMs: 5_000 }),
  ]);
  return { health, capabilities };
}

/**
 * La route steer est optionnelle et récente. Exiger à la fois le feature flag
 * et l'endpoint annoncé empêche de transformer un 404 de vieux runtime en
 * prétendu succès ou en perte du workflow de repli.
 */
export async function runSteerSupported(ctx: HermesClientContext): Promise<boolean> {
  const body = await ctx.json("/v1/capabilities", { timeoutMs: 5_000 });
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const capabilities = body as Record<string, unknown>;
  const features = record(capabilities.features);
  const endpoints = record(capabilities.endpoints);
  const endpoint = record(endpoints?.run_steer);
  return features?.run_steer === true && endpoint?.method === "POST" &&
    endpoint.path === "/v1/runs/{run_id}/steer";
}

/**
 * Ce qu'un préfixe `/p/<slug>` vaut RÉELLEMENT sur ce runtime.
 *
 * L'ancienne version se contentait d'un `GET /p/<slug>/health` et lisait un
 * 200 comme « le profil existe ». C'était un FAUX VERT : quand
 * `gateway.multiplex_profiles` est coupé (le défaut), le gateway IGNORE le
 * préfixe et sert la requête comme le profil par défaut
 * (`gateway/platforms/api_server.py`, `_resolve_profile`). Mesuré le
 * 2026-08-26 : `/p/scout/health` rendait 200 alors qu'aucun
 * profil `scout` n'existait, et les trois bots partageaient un seul
 * `HERMES_HOME`, donc une seule mémoire, un seul workspace.
 *
 * D'où la sonde de CONTRÔLE : un slug qui ne peut appartenir à personne. S'il
 * répond lui aussi, c'est le multiplexage qui est coupé, et aucun `/p/<slug>`
 * ne cloisonne quoi que ce soit sur ce runtime.
 */
/** Slug prefix of the control probe: no profile ever carries it, so its 404 is the expected answer. */
export const CONTROL_PROFILE_PREFIX = "openedbot-control-";

export async function probeProfileIsolation(ctx: HermesClientContext, slug: string): Promise<HermesProfileIsolation> {
  const control = `${CONTROL_PROFILE_PREFIX}${sessionFingerprint(slug)}`;
  const [profile, sentinel] = await Promise.all([
    profileHealth(ctx, slug),
    profileHealth(ctx, control),
  ]);
  if (sentinel === "ok") return "not_partitioned";
  return profile === "ok" ? "isolated" : "missing";
}

async function profileHealth(ctx: HermesClientContext, slug: string): Promise<"ok" | "missing"> {
  const client = ctx.withProfile(slug);
  try {
    await client.json("/health", { timeoutMs: 5_000 });
    return "ok";
  } catch (error) {
    if (error instanceof HermesClientError && error.status === 404) return "missing";
    throw error;
  }
}

export async function models(ctx: HermesClientContext): Promise<Array<{ id: string }>> {
  const body = await ctx.json("/v1/models", { timeoutMs: 5_000 }) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new HermesClientError("Le catalogue Hermes est invalide.", 502, "HERMES_RESPONSE_INVALID");
  }
  return body.data
    .map((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
      ? { id: (item as { id: string }).id } : null)
    .filter((item): item is { id: string } => item !== null);
}

export async function modelOptions(ctx: HermesClientContext): Promise<HermesModelOptions> {
  return parseModelOptions(await ctx.json("/api/model/options", { timeoutMs: 8_000 }));
}

/**
 * The catalogue of the host's DEFAULT profile, whatever profile this client
 * runs under: its `provider`/`model` is the host's own default, which a bot
 * profile cloned from it stops following once a run writes its model.
 */
export async function defaultProfileModelOptions(ctx: HermesClientContext): Promise<HermesModelOptions> {
  return modelOptions(ctx.profile ? ctx.withProfile(null) : ctx);
}

/**
 * Ce que l'hôte du runtime sait faire, par la route HÔTE
 * `GET /hermes-setup/capabilities` (docs/CONNECTOR.md, « Fournisseurs par
 * le lien »). Rend le tableau `features` annoncé (`provider_management`
 * quand l'opérateur de l'hôte sert les quatre verbes fournisseur), ou
 * `null` quand l'hôte n'a pas d'opérateur : 404 en direct (Caddy sans
 * route, ou un gateway qui ne connaît pas ce chemin),
 * `HERMES_OPERATOR_UNAVAILABLE` ou `HERMES_LINK_PATH_FORBIDDEN` par le
 * lien. Toute autre erreur remonte : elle dit autre chose que « je ne
 * l'ai pas ».
 */
export async function hostCapabilities(ctx: HermesClientContext): Promise<string[] | null> {
  let response: Response;
  try {
    response = await ctx.hostRequest("/hermes-setup/capabilities", { method: "GET" }, "safe", HOST_CAPABILITIES_TIMEOUT_MS);
  } catch (error) {
    if (
      error instanceof HermesClientError
      && (error.code === "HERMES_OPERATOR_UNAVAILABLE" || error.code === "HERMES_LINK_PATH_FORBIDDEN")
    ) {
      return null;
    }
    throw error;
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseHostCapabilitiesResponse(await ctx.providerJson(response));
}

/**
 * Quels SDK fournisseur l'hôte a installés, par la route HÔTE
 * `GET /hermes-setup/provider-sdks` (feature `provider_sdks`). L'appelant ne
 * la lit que si l'hôte annonce la feature : toute erreur remonte, y compris
 * le 503 d'une sonde en échec, pour qu'il choisisse son repli.
 */
export async function hostProviderSdks(ctx: HermesClientContext): Promise<HermesProviderSdk[]> {
  const response = await ctx.hostRequest("/hermes-setup/provider-sdks", { method: "GET" }, "safe", HOST_CAPABILITIES_TIMEOUT_MS);
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseHostProviderSdksResponse(await ctx.providerJson(response));
}

/**
 * Inventaire des outils et des skills du runtime.
 *
 * Les deux lectures partent ENSEMBLE et échouent séparément : un build sans
 * `skills_api` doit quand même rendre ses toolsets. Seul un 404 vaut
 * « endpoint absent » et retombe sur `null` ; toute autre erreur remonte,
 * parce qu'un runtime injoignable et un runtime sans skills ne se soignent
 * pas de la même façon.
 */
export async function capabilityInventory(ctx: HermesClientContext): Promise<HermesCapabilityInventory> {
  const [toolsetList, skills] = await Promise.all([
    toolsets(ctx),
    optionalSkills(ctx),
  ]);
  return { toolsets: toolsetList, ...skills };
}

/**
 * `/v1/skills` en section optionnelle. Hermes enveloppe son énumération
 * dans un `except Exception` et répond 500 « Failed to enumerate skills »
 * au moindre skill illisible sur l'hôte : cet échec ne doit pas emporter
 * les toolsets, qui ont répondu. Seule une erreur du client Hermes est
 * absorbée ; une autre exception reste un défaut du code.
 */
async function optionalSkills(ctx: HermesClientContext): Promise<{ skills: HermesCapabilityInventory["skills"]; skillsFailed: boolean }> {
  try {
    const body = await ctx.optionalJson("/v1/skills");
    return { skills: body === null ? null : parseSkills(body), skillsFailed: false };
  } catch (error) {
    if (error instanceof HermesClientError) return { skills: null, skillsFailed: true };
    throw error;
  }
}

/**
 * Sonde le transport natif de contrôle navigateur du gateway Hermes.
 *
 * Cette lecture ne crée aucun ticket et n'attache aucun contrôleur. Même
 * `transport_compatible` ne vaut donc jamais « Computer pilotable » : il
 * prouve seulement que le gateway expose le protocole exact qu'un futur
 * contrôleur, scoped au Box et au run, pourrait utiliser.
 */
export async function browserControlTransportProbe(ctx: HermesClientContext): Promise<HermesBrowserControlTransportProbe> {
  const body = await ctx.optionalJson("/v1/capabilities");
  return body === null
    ? browserControlNotReported()
    : parseBrowserControlTransport(body);
}

/**
 * Vérifie GET `/api/mcp/servers` sans jamais appeler une route mutante.
 *
 * La route est volontairement sondée à la RACINE : contrairement aux
 * capacités d'un bot, l'administration MCP du Dashboard n'est pas sous
 * `/p/<slug>`. Les corps 401/403/404 sont détruits sans être remontés à
 * l'appelant, afin qu'une page de réglages ne puisse pas refléter un détail
 * d'authentification upstream.
 */
export async function connectorManagementProbe(ctx: HermesClientContext): Promise<HermesConnectorManagementProbe> {
  const rootClient = ctx.profile ? ctx.withProfile(null) : ctx;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("connector_management_timeout"), 5_000);
  try {
    const response = await rootClient.fetch("/api/mcp/servers", { signal: controller.signal });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { status: "not_exposed", serverCount: null };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return { status: "runtime_token_not_accepted", serverCount: null };
    }
    if (!response.ok) await rootClient.throwResponse(response, { profileMissingOn404: false });

    let body: unknown;
    try {
      body = await readBoundedJsonParser(response, MAX_INVENTORY_BODY_BYTES);
    } catch (error) {
      if (error instanceof HermesClientError) throw error;
      throw new HermesClientError(
        "Hermes a renvoyé une liste MCP non JSON.",
        502,
        "HERMES_RESPONSE_INVALID",
        { requestDelivery: "response_received", cause: error },
      );
    }
    const servers = body && typeof body === "object"
      ? (body as { servers?: unknown }).servers
      : null;
    if (!Array.isArray(servers)) {
      throw new HermesClientError(
        "Hermes a renvoyé une liste MCP invalide.",
        502,
        "HERMES_RESPONSE_INVALID",
        { requestDelivery: "response_received" },
      );
    }
    return { status: "read_endpoint_available", serverCount: servers.length };
  } finally {
    clearTimeout(timeout);
  }
}

/** Inventaire minimal utilisé par la gate de conformité avant tout run. */
export async function toolsets(ctx: HermesClientContext): Promise<HermesToolset[] | null> {
  const body = await ctx.optionalJson("/v1/toolsets");
  return body === null ? null : parseToolsets(body);
}

/**
 * `toolsets()` reused across runs on one link, for this client's
 * profile. A miss, an expired entry or a cache error reads live; a live
 * failure is thrown as is and nothing is remembered. `null` is never cached.
 * The caller gates the result exactly as it gates a live read.
 */
export async function cachedToolsets(ctx: HermesClientContext, scope: HermesToolsetInventoryScope): Promise<HermesToolset[] | null> {
  try {
    const cached = readCachedToolsetInventory(ctx.profile, scope);
    if (cached !== undefined) return cached;
  } catch {
    // Unreadable cache: read live, never a neighbouring value.
  }
  const inventory = await toolsets(ctx);
  try {
    rememberCachedToolsetInventory(ctx.profile, scope, inventory);
  } catch {
    // The live read answered; losing the write does not stop its use.
  }
  return inventory;
}

/**
 * Le runtime tient-il un journal rejouable (`features.event_replay`) ?
 *
 * Annoncé par le connecteur (docs/CONNECTOR.md) : `GET /v1/runs/{id}/events?since=<n>`
 * rejoue alors depuis `n+1`. Un gateway direct ne l'annonce pas et un flux
 * rompu n'y a d'autre issue que le polling.
 *
 * Avec un scope, la réponse (vraie ou fausse, quand la sonde a répondu) est
 * gardée par organisation, runtime et profil du client : TTL court, ou long
 * quand elle est ancrée sur l'instant du lien. Une erreur
 * de cache relance la sonde. Une erreur de sonde est fail-closed (pas de
 * rejeu) et n'est pas mémorisée, pour que le tour suivant réessaie.
 */
export async function eventReplaySupported(ctx: HermesClientContext, scope?: HermesPreflightScope): Promise<boolean> {
  const cacheable = Boolean(scope && scope.organizationId && scope.runtimeId);
  if (cacheable && scope) {
    try {
      const cached = readCachedEventReplay(ctx.profile, scope);
      if (cached !== undefined) return cached;
    } catch {
      // Cache illisible : on relit. On ne réutilise aucune valeur voisine.
    }
  }
  let supported: boolean;
  try {
    supported = await probeEventReplay(ctx);
  } catch {
    return false;
  }
  if (cacheable && scope) {
    try {
      rememberCachedEventReplay(ctx.profile, scope, supported);
    } catch {
      // La sonde a répondu. Perdre l'écriture n'empêche pas de s'en servir.
    }
  }
  return supported;
}

/**
 * Réponse de rejeu déjà en cache pour ce scope, sans sonde réseau.
 * `undefined` : pas d'entrée utilisable, l'appelant doit sonder.
 */
export function peekCachedEventReplay(ctx: HermesClientContext, scope: HermesPreflightScope): boolean | undefined {
  try {
    return readCachedEventReplay(ctx.profile, scope);
  } catch {
    return undefined;
  }
}

async function probeEventReplay(ctx: HermesClientContext): Promise<boolean> {
  const body = await ctx.json("/v1/capabilities", { timeoutMs: 5_000 });
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const features = record((body as Record<string, unknown>).features);
  return features?.event_replay === true;
}

/**
 * Ce que l'hôte accepte d'écrire côté toolsets, par la route HÔTE
 * `GET /hermes-setup/toolsets`. Ne double pas `/v1/toolsets` : le gateway
 * dit l'état, l'hôte dit ce qui est réglable sur sa plateforme `api_server`.
 */
export async function hostToolsets(ctx: HermesClientContext): Promise<HermesHostToolsets> {
  const response = await ctx.hostRequest("/hermes-setup/toolsets", { method: "GET" }, "safe", PROVIDER_POLL_TIMEOUT_MS);
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseHostToolsetsResponse(await ctx.providerJson(response));
}

/**
 * Les skills installées à la racine, lues par l'opérateur de l'hôte
 * (`skills_inventory`), au même format que `/v1/skills`. Le repli de
 * `capabilityInventory` quand le gateway échoue sur `/v1/skills` : Hermes
 * 0.21.3 à 0.22.6 y passe un argument retiré et répond 500 à chaque appel
 * (amont #142575, correctif PR #142662).
 */
export async function hostSkills(ctx: HermesClientContext): Promise<HermesCapabilityInventory["skills"]> {
  const response = await ctx.hostRequest("/hermes-setup/skills", { method: "GET" }, "safe", PROVIDER_POLL_TIMEOUT_MS);
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseSkills(await ctx.providerJson(response));
}

/**
 * Active ou désactive un toolset sur l'hôte.
 *
 * L'état rendu est celui que l'hôte a RELU sur `/v1/toolsets` après
 * l'écriture, jamais celui demandé : `hermes tools` imprime ses refus en
 * sortant quand même en 0, et `agent.disabled_toolsets` peut annuler une
 * activation. Un appelant qui affiche `requested` afficherait un succès qui
 * n'a pas eu lieu ; c'est `applied` qui tranche.
 */
export async function toolsetSet(ctx: HermesClientContext, name: string, enabled: boolean): Promise<HermesToolsetState> {
  const response = await ctx.hostRequest(
    `/hermes-setup/toolsets/${encodeURIComponent(name)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) },
    "mutation",
    TOOLSET_MUTATION_TIMEOUT_MS,
  );
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseToolsetStateResponse(await ctx.providerJson(response));
}
