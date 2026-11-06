import { Hono } from "hono";
import {
  HermesClientError,
  type HermesClient,
  type HermesClientConfig,
  type HermesModelContext,
} from "@openedbot/hermes";
import { runtimeAdminClient } from "@openedbot/runtimes/application/runtime-admin-client";
import { RELAY_FEATURE_MODEL_CONTEXT } from "@openedbot/contracts-connector";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { assertLinkReachable, runtimeClientConfig } from "@openedbot/runtimes/application/runtime-access";
import { readRuntimeRows } from "@openedbot/runtimes/application/runtime-rows";
import { requireOperator, type AppVariables } from "../identity/auth";
import { HttpError } from "../../interfaces/http/http-error";
import { runtimeLinks, type RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import { runtimeLinkLocator, type RuntimeLinkLocator } from "@openedbot/runtime-link/application/instances";
import type { RuntimeModelContextDto } from "@openedbot/contracts-api";
import { logger } from "@openedbot/platform-observability";

/**
 * La fenêtre de contexte d'un runtime, lue sur son hôte.
 *
 * Elle ne bouge qu'au changement de modèle ou de configuration, donc elle se
 * garde longtemps : quinze minutes ici, une lecture par runtime et par profil.
 * Le cache est en mémoire et ne contient ni URL ni bearer.
 */
const FRESH_MS = 15 * 60_000;
/** Après un échec, on ne relance pas avant ce délai : l'échec reste lisible. */
const FAILURE_BACKOFF_MS = 60_000;
/** Le profil est un slug Hermes, comme le préfixe `/p/<slug>`. */
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

type ContextClient = Pick<HermesClient, "modelContext">;
type ContextFailure = { code: string; status: number; message: string };
type CacheValue = { document: HermesModelContext; fetchedAt: Date; freshUntil: Date };
type CacheEntry = { value: CacheValue | null; failure: ContextFailure | null; failedAt: number };

export class RuntimeModelContextCache {
  private readonly entries = new Map<string, CacheEntry>();

  read(key: string): CacheEntry | null {
    return this.entries.get(key) ?? null;
  }

  put(key: string, value: CacheValue): void {
    this.entries.set(key, { value, failure: null, failedAt: 0 });
  }

  fail(key: string, failure: ContextFailure, at: number): void {
    this.entries.set(key, { value: null, failure, failedAt: at });
  }

  clear(): void {
    this.entries.clear();
  }

  /** Clés `<organisation>:<runtime>:<profil>` : retire toutes celles d'une organisation. */
  clearOrganization(organizationId: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${organizationId}:`)) this.entries.delete(key);
    }
  }
}

const sharedCache = new RuntimeModelContextCache();

/** Un changement de modèle ou de configuration rend la fenêtre en cache fausse. */
export function clearRuntimeModelContext(organizationId: string): void {
  sharedCache.clearOrganization(organizationId);
}

export type RuntimeModelContextRouteDeps = {
  clientFactory?: (config: HermesClientConfig) => ContextClient;
  cache?: RuntimeModelContextCache;
  now?: () => Date;
  locator?: RuntimeLinkLocator;
};

/** La fenêtre de contexte du modèle du runtime, réservée à owner/admin. */
export function runtimeModelContextRoutes(
  db: Db,
  config: ApiConfig,
  links: RuntimeLinks = runtimeLinks(),
  deps: RuntimeModelContextRouteDeps = {},
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const cache = deps.cache ?? sharedCache;
  const now = deps.now ?? (() => new Date());
  const createClient = deps.clientFactory ?? runtimeAdminClient;
  const locator = deps.locator ?? runtimeLinkLocator();

  routes.get("/:runtimeId/model-context", async (context) => {
    const auth = context.get("auth");
    // Avant tout cache, toute base et tout réseau : pas de canal temporel.
    requireOperator(auth);
    const runtimeId = context.req.param("runtimeId");
    const profile = context.req.query("profile") ?? "";
    if (profile && !PROFILE_PATTERN.test(profile)) {
      throw new HttpError(400, "PROFILE_INVALID", "Le profil demandé est invalide.");
    }
    const observedAt = now();
    const row = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await readRuntimeRows(tx, auth.organizationId);
      return rows.find((candidate) => candidate.id === runtimeId) ?? null;
    });
    if (!row) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Runtime introuvable.");
    // La colonne peut rester NULL après un balayage alors que le socket est
    // toujours tenu ici : le registre du broker fait foi avant elle.
    if (row.reachability === "connector" && row.linkConnectedAt === null && !links.connected(runtimeId)) {
      return context.json(unavailable(runtimeId, "disconnected", "link_closed"));
    }
    // Un runtime sans opérateur `edge-setup` ne peut PAS servir ce chiffre :
    // le gateway ne le publie nulle part. Le client retombe alors sur sa table.
    if (!row.linkFeatures.includes(RELAY_FEATURE_MODEL_CONTEXT)) {
      return context.json(unavailable(runtimeId, "unsupported", "feature_absent"));
    }

    // La connexion du lien fait partie de la clé : une mise à jour de l'hôte
    // (`edge-setup upgrade`) le reconnecte, et la lecture faite par l'ancienne
    // sonde ne doit pas survivre quinze minutes à la nouvelle. Constaté le
    // 2026-10-12 : un profil lu juste avant l'upgrade restait sans préambule
    // pendant que le profil racine, lu après, l'avait.
    const generation = row.linkConnectedAt?.getTime() ?? 0;
    const key = `${auth.organizationId}:${runtimeId}:${generation}:${row.selectedProvider ?? ""}:${row.selectedModel ?? ""}:${profile}`;
    const cached = cache.read(key);
    if (cached?.value && cached.value.freshUntil.getTime() > observedAt.getTime()) {
      return context.json(render(runtimeId, cached.value));
    }
    if (cached?.failure && observedAt.getTime() - cached.failedAt < FAILURE_BACKOFF_MS) {
      return context.json(renderFailure(runtimeId, cached.failure));
    }

    try {
      await assertLinkReachable(runtimeId, links, locator);
      const client = createClient(runtimeClientConfig(row, config, links));
      const document = await client.modelContext(profile ? { profile } : {});
      const value: CacheValue = {
        document,
        fetchedAt: observedAt,
        freshUntil: new Date(observedAt.getTime() + FRESH_MS),
      };
      cache.put(key, value);
      return context.json(render(runtimeId, value));
    } catch (error) {
      const failure = toFailure(error);
      cache.fail(key, failure, observedAt.getTime());
      logger.warn(
        { event: "api.runtime_model_context_failed", runtimeId, code: failure.code, status: failure.status },
        "runtime model context probe failed",
      );
      return context.json(renderFailure(runtimeId, failure));
    }
  });

  return routes;
}

function unavailable(
  runtimeId: string,
  status: RuntimeModelContextDto["status"],
  reason: RuntimeModelContextDto["reason"],
): RuntimeModelContextDto {
  return {
    runtimeId,
    status,
    reason,
    model: null,
    provider: null,
    contextWindow: 0,
    autoContextWindow: 0,
    maxOutputTokens: 0,
    preamble: null,
    fetchedAt: null,
    error: null,
  };
}

function render(runtimeId: string, value: CacheValue): RuntimeModelContextDto {
  return {
    runtimeId,
    status: "ok",
    reason: null,
    model: value.document.model,
    provider: value.document.provider,
    contextWindow: value.document.effectiveContextLength,
    autoContextWindow: value.document.autoContextLength,
    maxOutputTokens: value.document.maxOutputTokens,
    preamble: value.document.preamble ?? null,
    fetchedAt: value.fetchedAt.toISOString(),
    error: null,
  };
}

function renderFailure(runtimeId: string, failure: ContextFailure): RuntimeModelContextDto {
  // Une route absente sur un hôte plus ancien n'est pas une panne : c'est la
  // même chose qu'une capacité non annoncée, et le client doit retomber sur sa
  // table plutôt qu'afficher une erreur à un opérateur qui n'y peut rien.
  if (failure.status === 404) return unavailable(runtimeId, "unsupported", "feature_absent");
  return { ...unavailable(runtimeId, "error", null), error: failure.message };
}

/** Un message déjà normalisé : jamais une réponse upstream, jamais un secret. */
function toFailure(error: unknown): ContextFailure {
  if (error instanceof HermesClientError) {
    return { code: error.code, status: error.status, message: error.message };
  }
  if (error instanceof HttpError) {
    return { code: error.code, status: error.status, message: error.message };
  }
  return { code: "RUNTIME_UNREACHABLE", status: 502, message: "Le runtime n’a pas répondu." };
}
