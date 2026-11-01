import { createHash } from "node:crypto";
import type { HermesToolset } from "./contracts";

/**
 * Métadonnées de préflight Hermes (OHB-114).
 *
 * Une seule carte, dans le processus qui sonde. La clé est l'organisation, le
 * runtime ET le profil : deux bots, deux hôtes ou deux tenants ne partagent
 * jamais une réponse. Le TTL est court ; un hello, un changement d'inventaire
 * ou de modèle, ou une erreur de lecture, jettent l'entrée plutôt que de
 * servir une capacité périmée.
 *
 * OHB-137: `features.event_replay` is injected by the connector process
 * (journal present or not), so it cannot change without a new hello, which
 * moves `link_connected_at`. An entry anchored on that instant therefore lives
 * `HERMES_PREFLIGHT_LINK_TTL_MS`, long enough that consecutive turns on the
 * same link never probe again; an entry without the instant keeps the short
 * TTL.
 */
export const HERMES_PREFLIGHT_TTL_MS = 45_000;
export const HERMES_PREFLIGHT_LINK_TTL_MS = 12 * 60 * 60_000;

export type HermesPreflightScope = {
  organizationId: string;
  runtimeId: string;
  /** Posé par le worker : l'instant `link_connected_at`. Change au hello, pas au heartbeat. */
  linkConnectedAt?: string | null;
  /** Empreinte de l'inventaire toolset de CE profil. Une différence invalide l'entrée. */
  toolsetFingerprint?: string | null;
  /** Modèle que ce tour va demander. Une différence invalide l'entrée. */
  model?: string | null;
  /** Instant utilisé pour le TTL. Production l'omet (`Date.now`). Les tests le figent. */
  nowMs?: number;
};

export type HermesPreflightCacheStore = {
  get(key: string): HermesPreflightCacheEntry | undefined;
  set(key: string, value: HermesPreflightCacheEntry): void;
  delete(key: string): void;
  entries(): Iterable<[string, HermesPreflightCacheEntry]>;
  clear(): void;
};

export type HermesPreflightCacheEntry = {
  organizationId: string;
  runtimeId: string;
  profile: string | null;
  eventReplay: boolean;
  expiresAt: number;
  linkConnectedAt: string | null;
  toolsetFingerprint: string | null;
  model: string | null;
};

type ToolsetFingerprintInput = {
  name: string;
  enabled: boolean;
  configured: boolean;
  tools: readonly string[];
};

let store: HermesPreflightCacheStore = createMapStore();
let toolsetStore: HermesToolsetCacheStore = createToolsetMapStore();

function createMapStore(): HermesPreflightCacheStore {
  const map = new Map<string, HermesPreflightCacheEntry>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value); },
    delete: (key) => { map.delete(key); },
    entries: () => map.entries(),
    clear: () => { map.clear(); },
  };
}

function normalizeProfile(profile: string | null | undefined): string | null {
  if (profile == null) return null;
  const trimmed = profile.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cacheKey(organizationId: string, runtimeId: string, profile: string | null): string {
  return JSON.stringify([organizationId, runtimeId, profile ?? ""]);
}

function scoped(organizationId: string, runtimeId: string): boolean {
  return organizationId.length > 0 && runtimeId.length > 0;
}

function dropAll(): void {
  try { store.clear(); } catch { /* plus de cache : la prochaine sonde relit */ }
}

/** Magasin remplaçable dans les tests. `null` rend une carte vide. */
export function useHermesPreflightCacheStore(next: HermesPreflightCacheStore | null): void {
  store = next ?? createMapStore();
}

export function resetHermesPreflightCache(): void {
  store = createMapStore();
  toolsetStore = createToolsetMapStore();
}

function now(scope: { nowMs?: number }): number {
  return scope.nowMs ?? Date.now();
}

/**
 * Empreinte stable de l'inventaire. L'ordre des toolsets et des outils ne
 * compte pas : seul un vrai changement d'état invalide.
 * `null` (endpoint absent) n'est pas le même cas qu'un inventaire vide.
 */
export function hermesToolsetFingerprint(toolsets: readonly ToolsetFingerprintInput[] | null): string {
  if (toolsets === null) return "absent";
  const canonical = toolsets
    .map((toolset) => [
      toolset.name,
      toolset.enabled ? "1" : "0",
      toolset.configured ? "1" : "0",
      [...toolset.tools].sort().join(","),
    ].join("\0"))
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Jette le cache d'un runtime (tous les profils) ou d'un seul profil.
 * Omettre `profile` vide tout le runtime. N'envoie jamais.
 */
export function invalidateHermesPreflightCache(scope: {
  organizationId: string;
  runtimeId: string;
  profile?: string | null;
}): void {
  if (!scoped(scope.organizationId, scope.runtimeId)) return;
  const oneProfile = Object.hasOwn(scope, "profile") ? normalizeProfile(scope.profile) : undefined;
  try {
    for (const [key, entry] of [...store.entries()]) {
      if (!entry || entry.organizationId !== scope.organizationId || entry.runtimeId !== scope.runtimeId) continue;
      if (oneProfile !== undefined && entry.profile !== oneProfile) continue;
      store.delete(key);
    }
  } catch {
    dropAll();
  }
  try {
    for (const [key, entry] of [...toolsetStore.entries()]) {
      if (!entry || entry.organizationId !== scope.organizationId || entry.runtimeId !== scope.runtimeId) continue;
      if (oneProfile !== undefined && entry.profile !== oneProfile) continue;
      toolsetStore.delete(key);
    }
  } catch {
    dropAllToolsets();
  }
}

/**
 * Le worker appelle ça quand il relit `link_connected_at`. Un hello (nouvel
 * instant) jette tous les profils de ce runtime. Le même instant ne fait rien :
 * le heartbeat ne doit pas casser le cache.
 */
export function noteHermesPreflightLink(scope: {
  organizationId: string;
  runtimeId: string;
  linkConnectedAt: string | null;
}): void {
  if (!scoped(scope.organizationId, scope.runtimeId)) return;
  try {
    let moved = false;
    for (const [, entry] of store.entries()) {
      if (!entry || entry.organizationId !== scope.organizationId || entry.runtimeId !== scope.runtimeId) continue;
      if (entry.linkConnectedAt !== scope.linkConnectedAt) moved = true;
    }
    if (moved) {
      invalidateHermesPreflightCache({
        organizationId: scope.organizationId,
        runtimeId: scope.runtimeId,
      });
    }
  } catch {
    dropAll();
  }
}

/** `undefined` = pas d'entrée utilisable, il faut sonder. Une erreur de cache aussi. */
export function readCachedEventReplay(
  profile: string | null | undefined,
  scope: HermesPreflightScope,
): boolean | undefined {
  if (!scoped(scope.organizationId, scope.runtimeId)) return undefined;
  try {
    if (scope.linkConnectedAt !== undefined) {
      noteHermesPreflightLink({
        organizationId: scope.organizationId,
        runtimeId: scope.runtimeId,
        linkConnectedAt: scope.linkConnectedAt,
      });
    }
    const slug = normalizeProfile(profile);
    const key = cacheKey(scope.organizationId, scope.runtimeId, slug);
    const entry = store.get(key);
    if (!entry || entry.organizationId !== scope.organizationId || entry.runtimeId !== scope.runtimeId || entry.profile !== slug) {
      return undefined;
    }
    if (entry.expiresAt <= now(scope) || typeof entry.eventReplay !== "boolean") {
      store.delete(key);
      return undefined;
    }
    if (scope.toolsetFingerprint !== undefined && entry.toolsetFingerprint !== scope.toolsetFingerprint) {
      store.delete(key);
      return undefined;
    }
    if (scope.model !== undefined && entry.model !== scope.model) {
      store.delete(key);
      return undefined;
    }
    return entry.eventReplay;
  } catch {
    dropAll();
    return undefined;
  }
}

export function rememberCachedEventReplay(
  profile: string | null | undefined,
  scope: HermesPreflightScope,
  eventReplay: boolean,
): void {
  if (!scoped(scope.organizationId, scope.runtimeId) || typeof eventReplay !== "boolean") return;
  const slug = normalizeProfile(profile);
  const key = cacheKey(scope.organizationId, scope.runtimeId, slug);
  const at = now(scope);
  const sweptAt = Date.now();
  try {
    for (const [cachedKey, entry] of [...store.entries()]) {
      if (!entry || typeof entry.expiresAt !== "number" || entry.expiresAt <= sweptAt) store.delete(cachedKey);
    }
    store.set(key, {
      organizationId: scope.organizationId,
      runtimeId: scope.runtimeId,
      profile: slug,
      eventReplay,
      expiresAt: at + (scope.linkConnectedAt ? HERMES_PREFLIGHT_LINK_TTL_MS : HERMES_PREFLIGHT_TTL_MS),
      linkConnectedAt: scope.linkConnectedAt ?? null,
      toolsetFingerprint: scope.toolsetFingerprint ?? null,
      model: scope.model ?? null,
    });
  } catch {
    // La sonde a déjà répondu. Un cache en panne ne doit pas masquer ça.
  }
}

/**
 * OHB-138: the toolset inventory (`/v1/toolsets`) reused across runs.
 *
 * The worker paid a relay round trip for it on every run (225-253 ms on the
 * lab runtime) though it rarely changes. An entry is keyed by organization,
 * runtime and Hermes profile, and is only served while three things hold:
 *
 *   - the same `link_connected_at`: a hello (new connection) re-reads;
 *   - the same `runtimes.toolset_epoch`: the process holding the link bumps it
 *     after relaying any openedbot write that can change the inventory (see
 *     `hermesToolsetInventoryWrite`), and the worker reads it with the run
 *     context, so an API-side write invalidates a worker-side cache;
 *   - an age below `HERMES_TOOLSET_INVENTORY_TTL_MS`.
 *
 * The TTL is the maximum staleness for a change openedbot cannot see (an operator
 * running `edge-setup toolsets` on the host): such a change reaches runs at
 * most 60 s later. Only a real inventory is cached, never `null` (endpoint or
 * profile absent), and a cache failure only ever costs a live read. The caller
 * still applies the contract gate to whatever this returns.
 */
export const HERMES_TOOLSET_INVENTORY_TTL_MS = 60_000;

export type HermesToolsetInventoryScope = {
  organizationId: string;
  runtimeId: string;
  /** `link_connected_at`, normalized. Moves on hello, never on heartbeat. */
  linkConnectedAt: string;
  /** `runtimes.toolset_epoch`, as read with the run context. */
  toolsetEpoch: string;
  /** Instant used for the TTL. Production omits it (`Date.now`). Tests pin it. */
  nowMs?: number;
};

export type HermesToolsetCacheEntry = {
  organizationId: string;
  runtimeId: string;
  profile: string | null;
  linkConnectedAt: string;
  toolsetEpoch: string;
  expiresAt: number;
  inventory: HermesToolset[];
};

export type HermesToolsetCacheStore = {
  get(key: string): HermesToolsetCacheEntry | undefined;
  set(key: string, value: HermesToolsetCacheEntry): void;
  delete(key: string): void;
  entries(): Iterable<[string, HermesToolsetCacheEntry]>;
  clear(): void;
};

function createToolsetMapStore(): HermesToolsetCacheStore {
  const map = new Map<string, HermesToolsetCacheEntry>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value); },
    delete: (key) => { map.delete(key); },
    entries: () => map.entries(),
    clear: () => { map.clear(); },
  };
}

function dropAllToolsets(): void {
  try { toolsetStore.clear(); } catch { /* no cache: the next run reads live */ }
}

/** Replaceable store for tests. `null` restores an empty map. */
export function useHermesToolsetCacheStore(next: HermesToolsetCacheStore | null): void {
  toolsetStore = next ?? createToolsetMapStore();
}

function toolsetScoped(scope: HermesToolsetInventoryScope): boolean {
  return scoped(scope.organizationId, scope.runtimeId) && scope.linkConnectedAt.length > 0 && scope.toolsetEpoch.length > 0;
}

/** `undefined`: no usable entry, read live. A cache error too. Returns a copy. */
export function readCachedToolsetInventory(
  profile: string | null | undefined,
  scope: HermesToolsetInventoryScope,
): HermesToolset[] | undefined {
  if (!toolsetScoped(scope)) return undefined;
  try {
    const slug = normalizeProfile(profile);
    const key = cacheKey(scope.organizationId, scope.runtimeId, slug);
    const entry = toolsetStore.get(key);
    if (!entry || entry.organizationId !== scope.organizationId || entry.runtimeId !== scope.runtimeId || entry.profile !== slug) {
      return undefined;
    }
    if (
      entry.linkConnectedAt !== scope.linkConnectedAt
      || entry.toolsetEpoch !== scope.toolsetEpoch
      || entry.expiresAt <= now(scope)
      || !Array.isArray(entry.inventory)
    ) {
      toolsetStore.delete(key);
      return undefined;
    }
    return structuredClone(entry.inventory);
  } catch {
    dropAllToolsets();
    return undefined;
  }
}

export function rememberCachedToolsetInventory(
  profile: string | null | undefined,
  scope: HermesToolsetInventoryScope,
  inventory: HermesToolset[] | null,
): void {
  if (!toolsetScoped(scope) || !Array.isArray(inventory)) return;
  const slug = normalizeProfile(profile);
  const key = cacheKey(scope.organizationId, scope.runtimeId, slug);
  const sweptAt = Date.now();
  try {
    for (const [cachedKey, entry] of [...toolsetStore.entries()]) {
      if (!entry || typeof entry.expiresAt !== "number" || entry.expiresAt <= sweptAt) toolsetStore.delete(cachedKey);
    }
    toolsetStore.set(key, {
      organizationId: scope.organizationId,
      runtimeId: scope.runtimeId,
      profile: slug,
      linkConnectedAt: scope.linkConnectedAt,
      toolsetEpoch: scope.toolsetEpoch,
      expiresAt: now(scope) + HERMES_TOOLSET_INVENTORY_TTL_MS,
      inventory: structuredClone(inventory),
    });
  } catch {
    // The live read already answered. A broken cache must not hide it.
  }
}

/**
 * The relayed host routes after which the toolset inventory may differ:
 * toolset enable or disable (runtime or profile), MCP add, remove, catalogue
 * install, per-profile MCP switch and OAuth callback, gateway restart and its
 * job poll (the gateway reads MCP servers at boot only), profile creation and
 * deletion. Reads, runs and every other host verb leave the epoch alone.
 */
const TOOLSET_INVENTORY_WRITES: ReadonlyArray<readonly [string, RegExp]> = Object.freeze([
  ["POST", /^\/hermes-setup\/toolsets\/[^/]+$/],
  ["POST", /^\/hermes-setup\/profiles\/[^/]+\/toolsets\/[^/]+$/],
  ["POST", /^\/hermes-setup\/mcp\/servers$/],
  ["DELETE", /^\/hermes-setup\/mcp\/servers\/[^/]+$/],
  ["POST", /^\/hermes-setup\/mcp\/catalog\/[^/]+$/],
  ["POST", /^\/hermes-setup\/mcp\/servers\/[^/]+\/oauth\/callback$/],
  ["POST", /^\/hermes-setup\/profiles\/[^/]+\/mcp\/servers\/[^/]+$/],
  ["POST", /^\/hermes-setup\/gateway\/restart$/],
  ["GET", /^\/hermes-setup\/gateway\/restart\/[^/]+$/],
  ["POST", /^\/hermes-setup\/profiles$/],
  ["DELETE", /^\/hermes-setup\/profiles\/[^/]+$/],
] as const);

/** Does relaying `method path` call for a `runtimes.toolset_epoch` bump? */
export function hermesToolsetInventoryWrite(method: string, path: string): boolean {
  let candidate = path;
  const query = candidate.indexOf("?");
  if (query >= 0) candidate = candidate.slice(0, query);
  candidate = candidate.replace(/^\/p\/[a-z0-9][a-z0-9_-]{0,62}(?=\/)/, "");
  const upper = method.toUpperCase();
  return TOOLSET_INVENTORY_WRITES.some(([verb, pattern]) => verb === upper && pattern.test(candidate));
}
