import {
  HermesClientError,
  type HermesCapabilityInventory,
  type HermesConnectorManagementProbe,
  type HermesHostToolsets,
  type HermesMcpInventory,
  type HermesMcpOauthSession,
  type HermesMcpServer,
  type HermesToolset,
} from "@openedbot/hermes";
import { FORBIDDEN_TOOLSETS } from "@openedbot/runtimes/domain/runtime-contract";
import { mcpPublicServerEndpoint } from "@openedbot/runtimes/domain/mcp-connector-catalog";
import type {
  RuntimeIntegrationInventoryDto,
  RuntimeIntegrationMcpDto,
  RuntimeIntegrationMcpServerDto,
  RuntimeIntegrationToolsetDto,
  RuntimeMcpOauthDto,
} from "@openedbot/contracts-api";
import { HttpError } from "../../interfaces/http/http-error";
import {
  DEFAULT_INVENTORY_TIMEOUT_MS,
  MAX_MCP_TOKEN,
} from "./runtime-integration-constants";
import { RELAY_FEATURE_MCP_MANAGEMENT, RELAY_FEATURE_TOOLSET_MANAGEMENT } from "@openedbot/contracts-connector/features";

export function publicMcpOauth(session: HermesMcpOauthSession): RuntimeMcpOauthDto {
  return {
    sessionId: session.sessionId,
    server: session.server,
    status: session.status,
    callbackReceived: session.callbackReceived ?? null,
    authorizationUrl: session.authorizationUrl,
    error: session.error,
    errorCode: session.errorCode,
    discoveredTools: session.discoveredTools,
    expiresAt: session.expiresAt,
  };
}

export function runtimeIntegrationInventory(input: {
  runtime: { id: string; name: string } | null;
  inventory: HermesCapabilityInventory | null;
  failure: unknown;
  observedAt: string;
  canConfigure: boolean;
  managementProbe: HermesConnectorManagementProbe | null;
  hostFeatures: string[] | null;
  hostToolsets: HermesHostToolsets | null;
}): RuntimeIntegrationInventoryDto {
  const canWriteToolsets = input.hostFeatures?.includes(RELAY_FEATURE_TOOLSET_MANAGEMENT) === true;
  const canWriteMcp = input.hostFeatures?.includes(RELAY_FEATURE_MCP_MANAGEMENT) === true;
  // `settable` is true only if the host has NAMED the toolset. Without the list,
  // no switch is shown: offering the toggle of a toolset that
  // the upstream write would drop in silence would give a false success.
  const settable = new Set(input.hostToolsets?.settable ?? []);
  const toolsets = input.inventory?.toolsets === null || !input.inventory
    ? null
    : input.inventory.toolsets
      .map((toolset) => publicToolset(toolset, canWriteToolsets && settable.has(toolset.name)))
      .sort(compareToolsets);
  const skills = input.inventory?.skills?.map((skill) => ({
    ...skill,
    enabled: true,
    writable: false,
  })) ?? null;
  const support = toolsets !== null && skills !== null
    ? "available"
    : toolsets !== null || skills !== null
      ? "partial"
      : "unavailable";
  const enabled = toolsets?.filter((toolset) => toolset.enabled) ?? [];

  return {
    runtime: input.runtime,
    toolsets,
    skills,
    skillsError: input.inventory?.skillsFailed
      ? {
          code: "HERMES_SKILLS_UNAVAILABLE",
          message: "Hermes n’a pas pu lister ses skills : l’erreur vient du runtime.",
        }
      : null,
    support,
    totals: {
      ready: toolsets === null ? null : toolsets.filter((toolset) => toolset.status === "ready").length,
      configurationRequired: toolsets === null
        ? null
        : toolsets.filter((toolset) => toolset.status === "configuration_required").length,
      disabled: toolsets === null
        ? null
        : toolsets.filter((toolset) => toolset.status === "disabled").length,
      tools: toolsets === null ? null : new Set(enabled.flatMap((toolset) => toolset.tools)).size,
      skills: skills === null ? null : skills.length,
    },
    inventoryError: publicInventoryFailure(input.failure),
    management: {
      writable: canWriteToolsets || canWriteMcp,
      capabilities: { toolsets: canWriteToolsets, mcp: canWriteMcp },
      owner: "hermes",
      canConfigure: input.canConfigure,
      settingsPath: "/settings/runtime",
      status: input.runtime === null
        ? "runtime_missing"
        : input.managementProbe?.status ?? "unavailable",
      serverCount: input.managementProbe?.serverCount ?? null,
    },
    observedAt: input.observedAt,
  };
}

export function publicMcp(
  capabilities: RuntimeIntegrationMcpDto["capabilities"],
  inventory: HermesMcpInventory | null,
  failure: unknown,
): RuntimeIntegrationMcpDto {
  return {
    available: true,
    capabilities,
    servers: inventory?.servers.map(publicMcpServer) ?? [],
    catalog: inventory?.catalog ?? [],
    // A failed MCP read is SAID. A silent empty list would read as
    // « aucun connecteur », which is a claim one does not have.
    error: inventory === null ? publicWriteFailure(failure) : null,
  };
}

export { mcpPublicEndpoint as publicEndpoint } from "@openedbot/runtimes/domain/mcp-connector-catalog";

export function publicMcpServer(server: HermesMcpServer): RuntimeIntegrationMcpServerDto {
  return {
    name: server.name,
    transport: server.transport,
    endpoint: mcpPublicServerEndpoint(server),
    command: server.command,
    auth: server.auth,
    configEnabled: server.configEnabled,
    platformEnabled: server.platformEnabled,
    toolsIncluded: server.toolsIncluded,
    toolsExcluded: server.toolsExcluded,
    envKeys: server.envKeys,
    discoveredTools: server.discoveredTools,
    unreachable: server.unreachable,
    oauthTokenPresent: server.oauthTokenPresent,
  };
}

/** A catalog entry's variables: uppercase keys, bounded values. */
export function catalogEnv(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "ENV_INVALID", "`env` doit être un objet de variables.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) {
    throw new HttpError(400, "ENV_INVALID", "Une entrée de catalogue ne déclare pas plus de seize variables.");
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!/^[A-Z0-9_]{1,64}$/.test(key)) {
      throw new HttpError(400, "ENV_INVALID", "Ce nom de variable n’est pas valide : " + key.slice(0, 64));
    }
    if (typeof entry !== "string" || !entry || entry.length > MAX_MCP_TOKEN) {
      throw new HttpError(400, "ENV_INVALID", "La valeur de " + key + " est vide ou trop longue.");
    }
    out[key] = entry;
  }
  return out;
}

function publicToolset(toolset: HermesToolset, settable: boolean): RuntimeIntegrationToolsetDto {
  const forbidden = FORBIDDEN_TOOLSETS.has(toolset.name);
  return {
    ...toolset,
    status: !toolset.enabled
      ? "disabled"
      : toolset.configured
        ? "ready"
        : "configuration_required",
    // A forbidden toolset is never activated; it stays adjustable the other
    // way, so that the operator can turn it off from here if it is active.
    settable: settable && (!forbidden || toolset.enabled),
    forbidden,
  };
}

function compareToolsets(left: RuntimeIntegrationToolsetDto, right: RuntimeIntegrationToolsetDto): number {
  const priority = { configuration_required: 0, ready: 1, disabled: 2 } as const;
  if (left.status !== right.status) return priority[left.status] - priority[right.status];
  return left.name.localeCompare(right.name);
}

export class PublicInventoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * The failure of a WRITE, returned to the operator.
 *
 * The host's refusal codes pass through as they are, with their message: they
 * are written by the `edge-setup` operator, in a closed set, and say
 * precisely what to correct. Everything else falls back to a generic refusal,
 * with no upstream body.
 */
const HOST_REFUSALS: ReadonlyMap<string, number> = new Map([
  ["TOOLSET_INVALID", 400],
  ["TOOLSET_NOT_SETTABLE", 404],
  ["TOOLSET_FORBIDDEN", 403],
  ["TOOLSET_IN_PROGRESS", 409],
  ["TOOLSET_UNVERIFIED", 502],
  ["BODY_INVALID", 400],
  ["NAME_INVALID", 400],
  ["URL_INVALID", 400],
  ["AUTH_INVALID", 400],
  ["SECRET_INVALID", 400],
  ["STDIO_REFUSED", 400],
  ["TOKEN_REFUSED", 400],
  ["SERVER_REFUSED", 400],
  ["OAUTH_UNSUPPORTED", 400],
  ["ENV_UNKNOWN", 400],
  ["ENV_REQUIRED", 400],
  ["SERVER_EXISTS", 409],
  ["MCP_IN_PROGRESS", 409],
  ["SERVER_UNKNOWN", 404],
  ["CATALOG_ENTRY_UNKNOWN", 404],
  ["CATALOG_UNAVAILABLE", 404],
  ["INSTALL_FAILED", 502],
  // MCP OAuth and gateway restart.
  ["REDIRECT_INVALID", 400],
  ["OAUTH_UNAVAILABLE", 503],
  ["OAUTH_SESSION_NOT_FOUND", 404],
  ["OAUTH_CALLBACK_USED", 409],
  ["OAUTH_CALLBACK_INVALID", 400],
  ["OAUTH_CALLBACK_RECEIVED", 409],
  ["MCP_OAUTH_IN_PROGRESS", 409],
  ["PROFILE_NOT_FOUND", 404],
  ["GATEWAY_RESTART_UNAVAILABLE", 503],
  ["GATEWAY_RESTART_NOT_FOUND", 404],
  ["GATEWAY_RESTART_IN_PROGRESS", 409],
  ["PROFILE_INVALID", 400],
  ["PROFILE_UNVERIFIED", 502],
  ["AVATAR_NOT_FOUND", 404],
  ["AVATAR_TOO_LARGE", 502],
  ["SKILL_INVALID", 400],
  ["SKILL_NOT_FOUND", 404],
  ["SKILL_IN_PROGRESS", 409],
  ["SKILL_UNVERIFIED", 502],
  ["SKILL_IDENTIFIER_INVALID", 400],
  ["SKILL_QUERY_INVALID", 400],
  ["SKILL_SOURCE_INVALID", 400],
  ["SKILL_OPERATION_IN_PROGRESS", 409],
  ["SKILL_SCAN_BLOCKED", 409],
  ["SKILL_TRUST_REFUSED", 409],
  ["SKILL_INSTALL_UNVERIFIED", 502],
  ["SKILL_UNINSTALL_UNVERIFIED", 502],
  ["OPERATION_INTERRUPTED", 502],
]);

export function publicWriteError(failure: unknown): HttpError {
  if (failure instanceof HttpError) return failure;
  const detail = publicWriteFailure(failure);
  const status = detail === null ? 502 : HOST_REFUSALS.get(detail.code) ?? 502;
  return new HttpError(
    status,
    detail?.code ?? "RUNTIME_ADMIN_UNAVAILABLE",
    detail?.message ?? "L’hôte du runtime n’a pas pu réaliser cette opération.",
  );
}

function publicWriteFailure(failure: unknown): { code: string; message: string } | null {
  if (failure === null || failure === undefined) return null;
  if (failure instanceof HermesClientError) {
    if (HOST_REFUSALS.has(failure.code)) {
      return { code: failure.code, message: failure.message };
    }
    if (failure.code === "HERMES_OPERATOR_UNAVAILABLE" || failure.code === "HERMES_LINK_PATH_FORBIDDEN") {
      return {
        code: "RUNTIME_ADMIN_UNAVAILABLE",
        message: "L’hôte de ce runtime n’expose pas cette écriture. Mettez `edge-setup` à jour sur l’hôte.",
      };
    }
    if (failure.code === "HERMES_TOKEN_REJECTED") {
      return {
        code: "HERMES_TOKEN_REJECTED",
        message: "Hermes a refusé le token enregistré. Remplacez-le depuis les réglages du runtime.",
      };
    }
  }
  if (failure instanceof InventoryTimeoutError) {
    return {
      code: "HERMES_HOST_TIMEOUT",
      message: "L’hôte n’a pas répondu à temps. Aucun changement n’a été supposé.",
    };
  }
  return {
    code: "RUNTIME_ADMIN_UNAVAILABLE",
    message: "L’hôte du runtime n’a pas pu réaliser cette opération.",
  };
}

function publicInventoryFailure(failure: unknown): RuntimeIntegrationInventoryDto["inventoryError"] {
  if (failure === null || failure === undefined) return null;
  if (failure instanceof PublicInventoryError) {
    return { code: failure.code, message: failure.message };
  }
  if (failure instanceof InventoryTimeoutError) {
    return {
      code: "HERMES_INVENTORY_TIMEOUT",
      message: "Hermes n’a pas répondu à temps. Aucun état de connecteur n’a été supposé.",
    };
  }
  if (failure instanceof HermesClientError) {
    const code = [
      "HERMES_UNREACHABLE",
      "HERMES_TLS_INVALID",
      "HERMES_TOKEN_REJECTED",
      "HERMES_RESPONSE_INVALID",
      "HERMES_DESTINATION_FORBIDDEN",
      "HERMES_DNS_FAILED",
    ].includes(failure.code) ? failure.code : "HERMES_INVENTORY_UNAVAILABLE";
    const message = code === "HERMES_TOKEN_REJECTED"
      ? "Hermes a refusé le token enregistré. Remplacez-le depuis les réglages du runtime."
      : code === "HERMES_TLS_INVALID"
        ? "Le certificat TLS du runtime Hermes est invalide."
        : "L’inventaire Hermes est momentanément indisponible.";
    return { code, message };
  }
  return {
    code: "HERMES_INVENTORY_UNAVAILABLE",
    message: "L’inventaire Hermes est momentanément indisponible.",
  };
}

class InventoryTimeoutError extends Error {}

export async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new InventoryTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function safeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    return DEFAULT_INVENTORY_TIMEOUT_MS;
  }
  return Math.min(value, 30_000);
}
