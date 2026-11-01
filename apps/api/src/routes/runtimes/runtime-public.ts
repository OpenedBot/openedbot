import { RELAY_FEATURE_PROVIDER_MANAGEMENT } from "@openedbot/contracts-connector";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { pgTextArray } from "@openedbot/runtime-link/application/broker";
import type { RuntimeAdminMode, RuntimeProviderIncidentDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { runtimeConnector, type ConnectorVersions } from "@openedbot/platform-config/connector-version";
import { acceptedLinkOrigins, isRetiredLinkOrigin } from "@openedbot/runtime-link/application/link-pop";
import { connectorLinkCommand, connectorLinkPublicOrigin } from "./runtime-enrollment-routes";
import { type RuntimeExposureSummary } from "@openedbot/runtimes/sql/runtime-exposures";
import { type RuntimeRow } from "@openedbot/runtimes/sql/runtime-rows";

/** Le littéral `text[]` à écrire, ou `null` pour « ne pas toucher » (`coalesce` côté SQL). */
export function hostFeatureLiteral(features: string[] | null): string | null {
  return features === null ? null : pgTextArray(features);
}

export type RuntimeManagement = RuntimePublicDto["management"];

/** Direct access is always manual; host administration requires an announced connector feature. */
export function runtimeManagement(row: RuntimeRow, adminMode: RuntimeAdminMode): RuntimeManagement {
  if (row.reachability === "direct") return { kind: "manual", credentialsWritable: false, oauthWritable: false };
  if (adminMode === "local") {
    return { kind: "hermes_dashboard", credentialsWritable: true, oauthWritable: true };
  }
  if (row.linkFeatures.includes(RELAY_FEATURE_PROVIDER_MANAGEMENT)) {
    if (row.reachability === "connector") {
      const linked = row.linkConnectedAt !== null;
      return { kind: "host", credentialsWritable: linked, oauthWritable: linked };
    }
  }
  return { kind: "manual", credentialsWritable: false, oauthWritable: false };
}

/**
 * Bots served by a runtime. A bot carries no runtime id: the roster belongs
 * to the organization and every live bot runs on its ACTIVE runtime, so the
 * count is the organization's live roster (archived and trashed bots
 * excluded: trash implies archived) on the active runtime, 0 elsewhere.
 */
export async function readRosterBotCount(tx: Bun.TransactionSQL, organizationId: string): Promise<number> {
  const rows = await tx<Array<{ count: number | string }>>`
    select count(*)::int as count
      from bots
     where organization_id = ${organizationId} and archived_at is null
  `;
  return Number(rows[0]?.count ?? 0);
}

export function runtimeBotCount(row: Pick<RuntimeRow, "isActive">, rosterBotCount: number): number {
  return row.isActive ? rosterBotCount : 0;
}

/** `runtimeBotCount` read in its own tenant transaction: no query for a runtime that serves no bot. */
export async function readRuntimeBotCount(db: Db, organizationId: string, row: Pick<RuntimeRow, "isActive">): Promise<number> {
  if (!row.isActive) return 0;
  return runtimeBotCount(row, await withTenant(db, organizationId, (tx) => readRosterBotCount(tx, organizationId)));
}

/**
 * `publicRuntime` with its real `botCount`: every route that answers a single
 * runtime goes through here, so none answers the placeholder 0 for the
 * runtime that serves the roster. The listing reads (`GET /`, `GET /list`)
 * count inside their own transaction with the same `runtimeBotCount` rule.
 */
export async function publicRuntimeWithBots(
  db: Db,
  organizationId: string,
  ...args: Parameters<typeof publicRuntime>
): Promise<ReturnType<typeof publicRuntime>> {
  const dto = publicRuntime(...args);
  return { ...dto, botCount: await readRuntimeBotCount(db, organizationId, args[0]) };
}

export async function readActiveProviderIncidents(
  tx: Bun.TransactionSQL,
  organizationId: string,
  runtimeId: string,
): Promise<RuntimeProviderIncidentDto[]> {
  const rows = await tx<Array<{
    provider: string;
    kind: "quota" | "auth";
    firstSeenAt: Date | string;
    lastSeenAt: Date | string;
    until: Date | string;
    fallbackProvider: string | null;
    fallbackModel: string | null;
    message: string | null;
  }>>`
    select provider, kind, first_seen_at as "firstSeenAt", last_seen_at as "lastSeenAt", until,
           fallback_provider as "fallbackProvider", fallback_model as "fallbackModel", message
      from runtime_provider_incidents
     where organization_id = ${organizationId} and runtime_id = ${runtimeId} and until > now()
     order by last_seen_at desc
  `;
  return rows.map((row) => ({
    provider: row.provider,
    kind: row.kind,
    firstSeenAt: toIso(row.firstSeenAt) ?? new Date().toISOString(),
    lastSeenAt: toIso(row.lastSeenAt) ?? new Date().toISOString(),
    until: toIso(row.until) ?? new Date().toISOString(),
    fallbackProvider: row.fallbackProvider,
    fallbackModel: row.fallbackModel,
    message: row.message,
  }));
}

export type LinkPublication = {
  environment: ApiConfig["environment"];
  acceptedOrigins: readonly string[];
  relinkCommand: string;
};

/** Origines acceptées et commande de réenrôlement, lues sur la config de ce processus. */
export function linkPublication(config: Pick<ApiConfig, "environment" | "publicUrl" | "linkPublicUrl" | "linkLegacyPublicUrls">): LinkPublication {
  return {
    environment: config.environment,
    acceptedOrigins: acceptedLinkOrigins(config),
    relinkCommand: connectorLinkCommand(connectorLinkPublicOrigin(config, undefined)),
  };
}

export function publicRuntime(
  row: RuntimeRow,
  adminMode: RuntimeAdminMode,
  incidents: RuntimeProviderIncidentDto[] = [],
  connectorVersions: ConnectorVersions = {},
  exposure: RuntimeExposureSummary | null = null,
  publication?: LinkPublication,
) {
  const origin = row.linkOrigin ?? null;
  const originRetired = Boolean(origin && publication && isRetiredLinkOrigin(origin, publication));
  return {
    id: row.id,
    name: row.name,
    // `null` pour un runtime connector : aucune URL n'existe côté cloud.
    baseUrl: row.endpoint,
    configured: true,
    reachability: row.reachability,
    /** @deprecated Alias de `reachability`, conservé une version. */
    transport: row.reachability,
    link: row.reachability === "connector"
      ? {
          connector: runtimeConnector(row.linkAgent, toIso(row.linkAgentSeenAt ?? null), connectorVersions),
          connected: row.linkConnectedAt !== null,
          generation: row.linkConnectedAt !== null ? row.linkGeneration ?? null : null,
          connectedAt: toIso(row.linkConnectedAt),
          lastSeenAt: toIso(row.linkLastSeenAt),
          lastReplacedAt: toIso(row.linkLastReplacedAt),
          hijackSuspectedAt: toIso(row.linkHijackSuspectedAt),
          rotatedAt: toIso(row.linkRotatedAt),
          origin,
          originRetired,
          relinkCommand: originRetired && publication ? publication.relinkCommand : null,
        }
      : null,
    management: runtimeManagement(row, adminMode),
    isDefault: row.isActive,
    isActive: row.isActive,
    tokenConfigured: true,
    edgeAuthConfigured: row.reachability === "direct" && !!row.edgeAuthCiphertext,
    exposure: row.reachability === "direct" ? exposure : null,
    botCount: 0,
    selectedProvider: row.selectedProvider,
    selectedModel: row.selectedModel,
    reasoningEffort: row.reasoningEffort,
    detectedVersion: null,
    capabilities: { max_concurrent_runs: row.capacity },
    linkFeatures: row.reachability === "connector" ? row.linkFeatures : [],
    capacity: row.capacity,
    lastHealthStatus: row.lastHealthStatus,
    lastHealthError: row.lastHealthError,
    lastCheckedAt: toIso(row.lastProbedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    providerIncidents: incidents,
  };
}

export function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
