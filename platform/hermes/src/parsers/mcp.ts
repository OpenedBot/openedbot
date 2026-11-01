import { MCP_NAME_PATTERN } from "../contracts";
import type {
  HermesGatewayRestartJob,
  HermesGatewayStatus,
  HermesMcpAuth,
  HermesMcpCatalogEntry,
  HermesMcpCatalogEnvSpec,
  HermesMcpInventory,
  HermesMcpOauthSession,
  HermesMcpServer,
  HermesMcpTransport,
  HermesProviderOauthStatus,
} from "../contracts";
import {
  record,
  trimmed,
  nullableString,
  invalidProviderResponse,
  MAX_HOST_LIST,
  PROVIDER_OAUTH_STATUSES,
} from "./shared";

const MCP_TRANSPORTS: ReadonlySet<string> = new Set<HermesMcpTransport>(["http", "stdio", "unknown"]);
const MCP_AUTHS: ReadonlySet<string> = new Set<HermesMcpAuth>(["none", "header", "oauth"]);

export function parseMcpInventory(body: unknown): HermesMcpInventory {
  const bodyRecord = record(body);
  const platform = trimmed(bodyRecord?.platform);
  const servers = bodyRecord?.servers;
  const catalog = bodyRecord?.catalog;
  if (
    !bodyRecord
    || !platform
    || !Array.isArray(servers) || servers.length > MAX_HOST_LIST
    || !Array.isArray(catalog) || catalog.length > MAX_HOST_LIST
  ) throw invalidProviderResponse();
  return {
    platform,
    servers: servers.map(parseMcpServer),
    catalog: catalog.map(parseMcpCatalogEntry),
  };
}

export function parseMcpServer(body: unknown): HermesMcpServer {
  const bodyRecord = record(body);
  const name = trimmed(bodyRecord?.name);
  const transport = trimmed(bodyRecord?.transport);
  const auth = trimmed(bodyRecord?.auth);
  if (
    !bodyRecord
    || !name || !MCP_NAME_PATTERN.test(name)
    || !transport || !MCP_TRANSPORTS.has(transport)
    || !auth || !MCP_AUTHS.has(auth)
    || !nullableString(bodyRecord.endpoint)
    || !nullableString(bodyRecord.command)
    || typeof bodyRecord.configEnabled !== "boolean"
    || typeof bodyRecord.platformEnabled !== "boolean"
  ) throw invalidProviderResponse();
  return {
    name,
    transport: transport as HermesMcpTransport,
    endpoint: bodyRecord.endpoint,
    command: bodyRecord.command,
    auth: auth as HermesMcpAuth,
    configEnabled: bodyRecord.configEnabled,
    platformEnabled: bodyRecord.platformEnabled,
    toolsIncluded: hostStringList(bodyRecord.toolsIncluded, true),
    toolsExcluded: hostStringList(bodyRecord.toolsExcluded, true),
    envKeys: hostStringList(bodyRecord.envKeys, false) ?? [],
    discoveredTools: hostStringList(bodyRecord.discoveredTools, true),
    unreachable: bodyRecord.unreachable === true,
    // Absent d'un hôte plus ancien : `null`, jamais `false` : « on ne sait
    // pas » et « pas de jeton » ne se lisent pas pareil.
    oauthTokenPresent: typeof bodyRecord.oauthTokenPresent === "boolean" ? bodyRecord.oauthTokenPresent : null,
  };
}

const MCP_OAUTH_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const GATEWAY_RESTART_STATUSES: ReadonlySet<string> = new Set(["running", "ok", "failed"]);
const GATEWAY_RESTART_STEPS: ReadonlySet<string> = new Set(["restart", "health", "done"]);

export function parseMcpOauthSession(body: unknown): HermesMcpOauthSession {
  const bodyRecord = record(body);
  const server = trimmed(bodyRecord?.server);
  const errorCode = bodyRecord?.errorCode;
  if (
    !bodyRecord
    || typeof bodyRecord.sessionId !== "string"
    || !server || !MCP_NAME_PATTERN.test(server)
    || typeof bodyRecord.status !== "string"
    || !PROVIDER_OAUTH_STATUSES.has(bodyRecord.status)
    || !nullableString(bodyRecord.authorizationUrl)
    || !nullableString(bodyRecord.error)
    || !(errorCode === null || errorCode === undefined || (typeof errorCode === "string" && MCP_OAUTH_ERROR_CODE_PATTERN.test(errorCode)))
    || typeof bodyRecord.expiresAt !== "string"
  ) throw invalidProviderResponse();
  // L'URL à ouvrir est une localisation https bornée, ou rien : un `javascript:`
  // ou un `http://` d'un hôte compromis ne devient jamais un lien cliquable.
  const authorizationUrl = bodyRecord.authorizationUrl;
  if (authorizationUrl !== null && (!authorizationUrl.startsWith("https://") || authorizationUrl.length > 2_048)) {
    throw invalidProviderResponse();
  }
  return {
    sessionId: bodyRecord.sessionId,
    server,
    status: bodyRecord.status as HermesProviderOauthStatus,
    authorizationUrl,
    error: bodyRecord.error,
    errorCode: typeof errorCode === "string" ? errorCode : null,
    discoveredTools: hostStringList(bodyRecord.discoveredTools, false) ?? [],
    expiresAt: bodyRecord.expiresAt,
  };
}

export function parseGatewayRestartJob(body: unknown): HermesGatewayRestartJob {
  const bodyRecord = record(body);
  if (
    !bodyRecord
    || typeof bodyRecord.jobId !== "string" || !bodyRecord.jobId
    || typeof bodyRecord.status !== "string" || !GATEWAY_RESTART_STATUSES.has(bodyRecord.status)
    || typeof bodyRecord.step !== "string" || !GATEWAY_RESTART_STEPS.has(bodyRecord.step)
    || typeof bodyRecord.startedAt !== "string"
    || !nullableString(bodyRecord.finishedAt)
    || !nullableString(bodyRecord.error)
    || typeof bodyRecord.expiresAt !== "string"
  ) throw invalidProviderResponse();
  return {
    jobId: bodyRecord.jobId,
    status: bodyRecord.status as HermesGatewayRestartJob["status"],
    step: bodyRecord.step as HermesGatewayRestartJob["step"],
    startedAt: bodyRecord.startedAt,
    finishedAt: bodyRecord.finishedAt,
    error: bodyRecord.error,
    expiresAt: bodyRecord.expiresAt,
  };
}

export function parseGatewayStatus(body: unknown): HermesGatewayStatus {
  const bodyRecord = record(body);
  if (
    !bodyRecord
    || typeof bodyRecord.restartPending !== "boolean"
    || !nullableString(bodyRecord.pendingSince)
    || !nullableString(bodyRecord.activeSince)
  ) throw invalidProviderResponse();
  return {
    restartPending: bodyRecord.restartPending,
    pendingSince: bodyRecord.pendingSince,
    activeSince: bodyRecord.activeSince,
    job: bodyRecord.job === null || bodyRecord.job === undefined ? null : parseGatewayRestartJob(bodyRecord.job),
  };
}

function parseMcpCatalogEntry(body: unknown): HermesMcpCatalogEntry {
  const bodyRecord = record(body);
  const name = trimmed(bodyRecord?.name);
  const authType = trimmed(bodyRecord?.authType) ?? "none";
  const transport = trimmed(bodyRecord?.transport);
  const envSpecs = bodyRecord?.envSpecs;
  if (
    !bodyRecord
    || !name || !MCP_NAME_PATTERN.test(name)
    || transport !== "http" && transport !== "stdio"
    || !Array.isArray(envSpecs) || envSpecs.length > 32
  ) throw invalidProviderResponse();
  return {
    name,
    description: trimmed(bodyRecord.description),
    source: trimmed(bodyRecord.source),
    authType,
    authProvider: trimmed(bodyRecord.authProvider),
    transport,
    requiresInstall: bodyRecord.requiresInstall === true,
    envSpecs: envSpecs.map(parseMcpCatalogEnvSpec),
  };
}

function parseMcpCatalogEnvSpec(body: unknown): HermesMcpCatalogEnvSpec {
  const bodyRecord = record(body);
  const name = trimmed(bodyRecord?.name);
  if (!bodyRecord || !name || !/^[A-Z0-9_]{1,64}$/.test(name)) throw invalidProviderResponse();
  return {
    name,
    description: trimmed(bodyRecord.description),
    required: bodyRecord.required !== false,
    secret: bodyRecord.secret !== false,
  };
}

/**
 * Une liste de noms de l'hôte. `nullable` distingue « l'hôte n'en a pas parlé »
 * (aucun filtre d'outils) de « la liste est vide » (filtre qui n'autorise
 * rien) : les deux ne se disent pas pareil dans l'écran.
 */
function hostStringList(value: unknown, nullable: boolean): string[] | null {
  if (value === null || value === undefined) return nullable ? null : [];
  if (!Array.isArray(value) || value.length > MAX_HOST_LIST) throw invalidProviderResponse();
  const out: string[] = [];
  for (const entry of value) {
    const name = trimmed(entry);
    if (!name || name.length > 128) throw invalidProviderResponse();
    out.push(name);
  }
  return out;
}
