import { Hono } from "hono";
import {
  HermesClientError,
  type HermesClient,
  type HermesClientConfig,
  type HermesProviderUsageDocument,
} from "@openedbot/hermes";
import { runtimeAdminClient } from "@openedbot/runtimes/application/runtime-admin-client";
import { RELAY_FEATURE_PROVIDER_USAGE } from "@openedbot/contracts-connector";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { readOrganizationRuntimeModeIn } from "@openedbot/runtimes/application/runtime-mode";
import { assertLinkReachable, runtimeClientConfig } from "@openedbot/runtimes/application/runtime-access";
import { readRuntimeRows } from "@openedbot/runtimes/application/runtime-rows";
import { requireOperator, type AppVariables } from "../identity/auth";
import { HttpError } from "../../interfaces/http/http-error";
import { runtimeLinks, type RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import { runtimeLinkLocator, type RuntimeLinkLocator } from "@openedbot/runtime-link/application/instances";
import type { RuntimeProviderUsageDto } from "@openedbot/contracts-api";
import { logger } from "@openedbot/platform-observability";

const FRESH_MS = 2 * 60_000;
const STALE_MS = 15 * 60_000;
const MANUAL_REFRESH_MS = 30_000;
/** Après un échec, aucune relance automatique avant ce délai : l'échec reste lisible au lieu d'un « loading » perpétuel. */
const FAILURE_BACKOFF_MS = 30_000;

type UsageClient = Pick<HermesClient, "providerUsage">;
type UsageFailure = { code: string; status: number; message: string };
type CacheValue = { document: HermesProviderUsageDocument; fetchedAt: Date; freshUntil: Date; staleUntil: Date };
type CacheEntry = { value: CacheValue | null; failure: UsageFailure | null; failedAt: number; inflight: Promise<void> | null; lastManualRefreshAt: number };

/** Cache mémoire seulement : il ne contient jamais URL ni bearer runtime. */
export class RuntimeProviderUsageCache {
  private readonly entries = new Map<string, CacheEntry>();

  read(key: string): CacheEntry | null {
    return this.entries.get(key) ?? null;
  }

  start(key: string, now: () => Date, loader: () => Promise<HermesProviderUsageDocument>, force = false): CacheEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { value: null, failure: null, failedAt: 0, inflight: null, lastManualRefreshAt: 0 };
      this.entries.set(key, entry);
    }
    if (entry.inflight) return entry;
    if (!force && entry.failure && now().getTime() - entry.failedAt < FAILURE_BACKOFF_MS) return entry;
    // Une nouvelle tentative efface l'échec précédent : servir un vieux
    // « lien fermé » pendant 25 s de sonde figerait l'affichage après un
    // rétablissement. Le loader peut lever de façon synchrone (lien absent
    // ICI) : c'est un échec comme un autre, jamais un 503 sans DTO.
    entry.failure = null;
    entry.inflight = Promise.resolve().then(loader).then((document) => {
      // Le TTL part de la réponse obtenue, non du départ d'une sonde qui peut
      // légitimement prendre 25 s.
      const fetchedAt = now();
      entry!.value = {
        document,
        fetchedAt,
        freshUntil: new Date(fetchedAt.getTime() + FRESH_MS),
        staleUntil: new Date(fetchedAt.getTime() + STALE_MS),
      };
      entry!.failure = null;
    }).catch((error: unknown) => {
      entry!.failure = usageFailure(error);
      entry!.failedAt = now().getTime();
      logger.warn(
        { event: "api.runtime_provider_usage_unreadable", code: entry!.failure.code, status: entry!.failure.status },
        "runtime provider usage unreadable",
      );
    }).finally(() => {
      entry!.inflight = null;
    });
    return entry;
  }

  mayManuallyRefresh(key: string, now: Date): boolean {
    const entry = this.entries.get(key) ?? { value: null, failure: null, failedAt: 0, inflight: null, lastManualRefreshAt: 0 };
    if (!this.entries.has(key)) this.entries.set(key, entry);
    if (now.getTime() - entry.lastManualRefreshAt < MANUAL_REFRESH_MS) return false;
    entry.lastManualRefreshAt = now.getTime();
    return true;
  }
}

const sharedCache = new RuntimeProviderUsageCache();

export type RuntimeProviderUsageRouteDeps = {
  clientFactory?: (config: HermesClientConfig) => UsageClient;
  cache?: RuntimeProviderUsageCache;
  now?: () => Date;
  locator?: RuntimeLinkLocator;
};

/** Quotas de compte lus sur l'hôte du runtime, réservés à owner/admin. */
export function runtimeProviderUsageRoutes(
  db: Db,
  config: ApiConfig,
  links: RuntimeLinks = runtimeLinks(),
  deps: RuntimeProviderUsageRouteDeps = {},
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const cache = deps.cache ?? sharedCache;
  const now = deps.now ?? (() => new Date());
  const createClient = deps.clientFactory ?? runtimeAdminClient;
  const locator = deps.locator ?? runtimeLinkLocator();

  routes.get("/:runtimeId/provider-usage", async (context) => {
    const auth = context.get("auth");
    // Must happen before cache, DB and network reads: no timing side channel.
    requireOperator(auth);
    const runtimeId = context.req.param("runtimeId");
    const observedAt = now();
    const runtime = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await readRuntimeRows(tx, auth.organizationId);
      return {
        row: rows.find((candidate) => candidate.id === runtimeId) ?? null,
        mode: await readOrganizationRuntimeModeIn(tx, config, auth.organizationId),
      };
    });
    if (!runtime.row) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Runtime introuvable.");
    // La colonne peut rester NULL après un balayage alors que le socket est
    // toujours tenu ici : le registre du broker fait foi avant elle.
    if (runtime.row.reachability === "connector" && runtime.row.linkConnectedAt === null && !links.connected(runtimeId)) {
      return context.json(unavailable(runtimeId, "disconnected", "link_closed"));
    }
    if (!runtime.row.linkFeatures.includes(RELAY_FEATURE_PROVIDER_USAGE)) {
      return context.json(unavailable(runtimeId, "unsupported", "feature_absent"));
    }

    const key = `${auth.organizationId}:${runtimeId}`;
    const manual = context.req.query("refresh") === "1" && cache.mayManuallyRefresh(key, observedAt);
    const cached = cache.read(key);
    const value = cached?.value ?? null;
    const fresh = value !== null && value.freshUntil.getTime() > observedAt.getTime();
    const entry = !fresh || manual
      ? cache.start(key, now, async () => {
          await assertLinkReachable(runtimeId, links, locator);
          return createClient(runtimeClientConfig(runtime.row!, config, links)).providerUsage({ refresh: manual });
        }, manual)
      : cached;
    if (manual && entry) {
      // « Actualiser » attend la sonde : rendre l'ancienne valeur en « stale »
      // laissait le bouton sans effet visible (mesuré le 05-09 : les relances
      // suivantes retombaient sur l'ancien relevé encore « frais » deux
      // minutes). La sonde est bornée par le client Hermes (40 s).
      await entry.inflight;
      if (entry.failure) return context.json(renderFailure(runtimeId, entry.failure));
      if (entry.value !== null) return context.json(render(runtimeId, "ok", entry.value));
      return context.json(unavailable(runtimeId, "loading", null));
    }
    const stale = value !== null && value.staleUntil.getTime() > observedAt.getTime();
    if (fresh) return context.json(render(runtimeId, "ok", value!));
    if (stale) return context.json(render(runtimeId, "stale", value!));
    if (entry?.failure) return context.json(renderFailure(runtimeId, entry.failure));
    return context.json(unavailable(runtimeId, "loading", null));
  });

  return routes;
}

function unavailable(runtimeId: string, status: RuntimeProviderUsageDto["status"], reason: RuntimeProviderUsageDto["reason"]): RuntimeProviderUsageDto {
  return { runtimeId, status, reason, fetchedAt: null, freshUntil: null, providers: [], error: null };
}

function render(runtimeId: string, status: "ok" | "stale", value: CacheValue): RuntimeProviderUsageDto {
  return {
    runtimeId,
    status,
    reason: null,
    fetchedAt: value.document.fetchedAt,
    freshUntil: value.freshUntil.toISOString(),
    providers: value.document.providers,
    error: null,
  };
}

function renderFailure(runtimeId: string, failure: UsageFailure): RuntimeProviderUsageDto {
  if (failure.status === 404 || failure.code === "HERMES_LINK_PATH_FORBIDDEN") return unavailable(runtimeId, "unsupported", "feature_absent");
  // Un opérateur hôte absent n'est pas un lien fermé : le socket est ouvert,
  // c'est le service `hermes-operator` qui manque. Le message le dit.
  if (failure.code === "RUNTIME_LINK_UNAVAILABLE") return unavailable(runtimeId, "disconnected", "link_closed");
  return { runtimeId, status: "error", reason: null, fetchedAt: null, freshUntil: null, providers: [], error: failure.message };
}

function usageFailure(error: unknown): UsageFailure {
  if (error instanceof HermesClientError) return { code: error.code, status: error.status, message: publicUsageError(error.code) };
  if (error instanceof HttpError) return { code: error.code, status: error.status, message: error.message };
  return { code: "HERMES_UNREACHABLE", status: 502, message: "Les limites fournisseur sont momentanément indisponibles." };
}

function publicUsageError(code: string): string {
  if (code === "USAGE_PROBE_TIMEOUT") return "La lecture des limites fournisseur a dépassé le délai prévu.";
  if (code === "HERMES_OPERATOR_UNAVAILABLE") return "L’opérateur de l’hôte Hermes est indisponible.";
  return "Les limites fournisseur sont momentanément indisponibles.";
}
