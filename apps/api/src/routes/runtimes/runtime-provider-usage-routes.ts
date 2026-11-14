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

/**
 * A reading served without a new host probe. Five minutes, above the
 * console's slow cadence: at two minutes, equal to it, every poll landed
 * just after expiry, got `stale`, started a probe and re-polled at 2 s.
 * The console polls
 * at `freshUntil`. Cache, dedup and the manual bound are per API process:
 * several replicas may each probe the same host.
 */
export const PROVIDER_USAGE_FRESH_MS = 5 * 60_000;
const FRESH_MS = PROVIDER_USAGE_FRESH_MS;
const STALE_MS = 15 * 60_000;
const MANUAL_REFRESH_MS = 30_000;
/** After a failure, no automatic retry before this delay: the failure stays readable instead of a perpetual « loading ». */
const FAILURE_BACKOFF_MS = 30_000;

type UsageClient = Pick<HermesClient, "providerUsage">;
type UsageFailure = { code: string; status: number; message: string };
type CacheValue = { document: HermesProviderUsageDocument; fetchedAt: Date; freshUntil: Date; staleUntil: Date };
type CacheEntry = { value: CacheValue | null; failure: UsageFailure | null; failedAt: number; inflight: Promise<void> | null; lastManualRefreshAt: number };

/** Memory cache only: it never contains a URL or a runtime bearer. */
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
    // A new attempt clears the previous failure: serving an old
    // « lien fermé » during 25 s of probing would freeze the display after a
    // recovery. The loader can throw synchronously (link absent
    // HERE): that is a failure like any other, never a 503 without a DTO.
    entry.failure = null;
    entry.inflight = Promise.resolve().then(loader).then((document) => {
      // The TTL starts from the response obtained, not from the start of a probe that can
      // legitimately take 25 s.
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

/** Account quotas read on the runtime's host, reserved to owner/admin. */
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
    // The column can stay NULL after a sweep while the socket is
    // still held here: the broker's registry prevails over it.
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
      // « Actualiser » waits for the probe: returning the old value as « stale »
      // left the button with no visible effect (measured on 05-09: the later
      // retries fell back on the old reading still « frais » for two
      // minutes). The probe is bounded by the Hermes client (40 s).
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
  // An absent host operator is not a closed link: the socket is open,
  // it is the `hermes-operator` service that is missing. The message says so.
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
