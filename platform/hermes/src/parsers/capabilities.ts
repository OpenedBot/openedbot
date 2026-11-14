import { RELAY_MAX_FEATURES } from "@openedbot/contracts-connector";
import {
  HERMES_BROWSER_CONTROL_PROTOCOL_VERSION,
  HERMES_BROWSER_CONTROL_REQUIRED_CAPABILITIES,
  TOOLSET_KEY_PATTERN,
  TOOLSET_UNAVAILABLE_REASONS,
} from "../contracts";
import type {
  HermesBrowserControlCapability,
  HermesBrowserControlTransportProbe,
  HermesHostToolsets,
  HermesProviderSdk,
  HermesSkill,
  HermesToolset,
  HermesToolsetAvailability,
  HermesToolsetUnavailableReason,
  HermesToolsetState,
} from "../contracts";
import { HermesClientError } from "../errors";
import { record, trimmed, invalidProviderResponse, responseInvalid, MAX_HOST_LIST } from "./shared";

const HOST_FEATURE_PATTERN = /^[a-z0-9_]{1,64}$/;

export function parseHostCapabilities(body: unknown): string[] {
  const bodyRecord = record(body);
  const features = bodyRecord?.features;
  if (!Array.isArray(features) || features.length > RELAY_MAX_FEATURES) throw invalidProviderResponse();
  const parsed: string[] = [];
  for (const entry of features) {
    if (typeof entry !== "string" || !HOST_FEATURE_PATTERN.test(entry)) throw invalidProviderResponse();
    parsed.push(entry);
  }
  return parsed;
}

const PROVIDER_SDK_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_PROVIDER_SDKS = 32;
const MAX_PROVIDER_SDK_LABEL = 80;

/**
 * `GET /hermes-setup/provider-sdks`. Une entrée hors grammaire est REFUSÉE,
 * pas ignorée : la liste décide si un fournisseur est utilisable, et une
 * liste amputée en silence ferait passer pour « inconnu » un SDK absent.
 */
export function parseHostProviderSdks(body: unknown): HermesProviderSdk[] {
  const providers = record(body)?.providers;
  if (!Array.isArray(providers) || providers.length > MAX_PROVIDER_SDKS) throw invalidProviderResponse();
  return providers.map((entry): HermesProviderSdk => {
    const item = record(entry);
    if (
      !item
      || typeof item.provider !== "string" || !PROVIDER_SDK_SLUG_PATTERN.test(item.provider)
      || typeof item.label !== "string" || item.label.length > MAX_PROVIDER_SDK_LABEL
      || typeof item.extra !== "string" || !PROVIDER_SDK_SLUG_PATTERN.test(item.extra)
      || typeof item.installed !== "boolean"
      || typeof item.installable !== "boolean"
    ) throw invalidProviderResponse();
    return { provider: item.provider, label: item.label, extra: item.extra, installed: item.installed, installable: item.installable };
  });
}

export function parseHostToolsets(body: unknown): HermesHostToolsets {
  const bodyRecord = record(body);
  const platform = trimmed(bodyRecord?.platform);
  const settable = bodyRecord?.settable;
  if (!bodyRecord || !platform || !Array.isArray(settable) || settable.length > MAX_HOST_LIST) {
    throw invalidProviderResponse();
  }
  const names: string[] = [];
  for (const entry of settable) {
    // Un nom hors grammaire est REFUSÉ, pas ignoré : la liste sert à décider
    // si un interrupteur peut exister, et une liste amputée en silence
    // masquerait un toolset que l'hôte accepte pourtant d'écrire.
    if (typeof entry !== "string" || !TOOLSET_KEY_PATTERN.test(entry)) throw invalidProviderResponse();
    names.push(entry);
  }
  return { platform, settable: names, availability: parseToolsetAvailability(bodyRecord.availability) };
}

/**
 * Optionnel et tolérant, à l'inverse de `settable` : l'absence ou une forme
 * illisible disent « non mesuré » (`null`), jamais « disponible », et ne font
 * pas échouer la lecture de ce que l'hôte accepte d'écrire. Une ligne
 * invalide est écartée : son toolset reste alors inconnu.
 */
function parseToolsetAvailability(value: unknown): HermesToolsetAvailability[] | null {
  if (!Array.isArray(value) || value.length > MAX_HOST_LIST) return null;
  const rows: HermesToolsetAvailability[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const row = record(entry);
    if (!row || typeof row.name !== "string" || !TOOLSET_KEY_PATTERN.test(row.name) || seen.has(row.name)) continue;
    if (row.available !== null && typeof row.available !== "boolean") continue;
    seen.add(row.name);
    const reason = row.available === false
      && (TOOLSET_UNAVAILABLE_REASONS as readonly unknown[]).includes(row.reason)
      ? (row.reason as HermesToolsetUnavailableReason)
      : null;
    rows.push({ name: row.name, available: row.available, reason });
  }
  return rows;
}

export function parseToolsetState(body: unknown): HermesToolsetState {
  const bodyRecord = record(body);
  const name = trimmed(bodyRecord?.name);
  const platform = trimmed(bodyRecord?.platform);
  if (
    !bodyRecord
    || !name
    || !platform
    || typeof bodyRecord.enabled !== "boolean"
    || typeof bodyRecord.requested !== "boolean"
  ) throw invalidProviderResponse();
  // `applied` est RECALCULÉ ici. L'hôte l'envoie, mais c'est la seule valeur
  // qui décide si l'écran annonce un succès : elle se déduit de deux booléens
  // qu'on a déjà, plutôt que de se croire sur parole.
  return {
    name,
    platform,
    enabled: bodyRecord.enabled,
    requested: bodyRecord.requested,
    applied: bodyRecord.enabled === bodyRecord.requested,
  };
}

export function normalizeHermesBrowserControlTransport(input: unknown): HermesBrowserControlTransportProbe {
  if (!input || typeof input !== "object") {
    throw responseInvalid("Hermes a renvoyé des capacités illisibles.");
  }
  const body = input as Record<string, unknown>;
  if (!body.features || typeof body.features !== "object") {
    return browserControlProbe("not_reported", "FEATURE_NOT_ADVERTISED");
  }
  const features = body.features as Record<string, unknown>;
  if (!("browser_extension_control" in features)) {
    return browserControlProbe("not_reported", "FEATURE_NOT_ADVERTISED");
  }
  const rawFeature = features.browser_extension_control;
  if (!rawFeature || typeof rawFeature !== "object" || Array.isArray(rawFeature)) {
    return browserControlProbe("incompatible", "PROTOCOL_INCOMPATIBLE");
  }
  const feature = rawFeature as Record<string, unknown>;
  const protocolVersion = typeof feature.protocol_version === "number"
    && Number.isInteger(feature.protocol_version)
    ? feature.protocol_version
    : null;
  const capabilities = Array.isArray(feature.capabilities)
    ? [...new Set(feature.capabilities.filter(
        (value): value is HermesBrowserControlCapability =>
          typeof value === "string"
          && HERMES_BROWSER_CONTROL_REQUIRED_CAPABILITIES.includes(value as HermesBrowserControlCapability),
      ))].sort()
    : [];
  if (feature.enabled !== true) return browserControlProbe("disabled", "FEATURE_DISABLED", protocolVersion, capabilities);
  if (protocolVersion !== HERMES_BROWSER_CONTROL_PROTOCOL_VERSION) {
    return browserControlProbe("incompatible", "PROTOCOL_INCOMPATIBLE", protocolVersion, capabilities);
  }
  if (feature.real_browser_actions !== true) {
    return browserControlProbe("incompatible", "REAL_ACTIONS_NOT_ATTESTED", protocolVersion, capabilities);
  }
  const endpoints = body.endpoints && typeof body.endpoints === "object"
    ? body.endpoints as Record<string, unknown>
    : null;
  if (
    !matchesEndpoint(endpoints?.browser_control_register, "POST", "/v1/browser-control/register")
    || !matchesEndpoint(endpoints?.browser_control_ws, "GET", "/v1/browser-control/ws")
  ) {
    return browserControlProbe("incompatible", "ENDPOINT_CONTRACT_INVALID", protocolVersion, capabilities);
  }
  const transports = feature.transports && typeof feature.transports === "object"
    ? feature.transports as Record<string, unknown>
    : null;
  if (transports?.local_vps !== "websocket-subprotocol-ticket") {
    return browserControlProbe("incompatible", "TRANSPORT_NOT_SUPPORTED", protocolVersion, capabilities);
  }
  if (capabilities.length !== HERMES_BROWSER_CONTROL_REQUIRED_CAPABILITIES.length) {
    return browserControlProbe("incompatible", "CAPABILITIES_INCOMPLETE", protocolVersion, capabilities);
  }
  return browserControlProbe("transport_compatible", null, protocolVersion, capabilities);
}

export function normalizeHermesToolsets(input: unknown): HermesToolset[] {
  return listData(input, "La liste des toolsets Hermes est invalide.").flatMap((raw) => {
    const item = record(raw);
    const name = trimmed(item?.name);
    if (!item || !name) return [];
    return [{
      name,
      label: trimmed(item.label) ?? name,
      description: trimmed(item.description),
      enabled: item.enabled === true,
      configured: item.configured === true,
      tools: [...new Set((Array.isArray(item.tools) ? item.tools : [])
        .map((tool) => trimmed(tool))
        .filter((tool): tool is string => tool !== null))].sort(),
    }];
  });
}

export function normalizeHermesSkills(input: unknown): HermesSkill[] {
  return listData(input, "La liste des skills Hermes est invalide.").flatMap((raw) => {
    const item = record(raw);
    const name = trimmed(item?.name);
    if (!item || !name) return [];
    return [{ name, description: trimmed(item.description), category: trimmed(item.category) }];
  });
}

function browserControlProbe(
  status: HermesBrowserControlTransportProbe["status"],
  reason: HermesBrowserControlTransportProbe["reason"],
  protocolVersion: number | null = null,
  capabilities: HermesBrowserControlCapability[] = [],
): HermesBrowserControlTransportProbe {
  return { status, reason, protocolVersion, capabilities, controllerBindingProven: false };
}

function matchesEndpoint(value: unknown, method: string, path: string): boolean {
  const endpoint = record(value);
  return endpoint?.method === method && endpoint.path === path;
}

function listData(input: unknown, message: string): unknown[] {
  const body = record(input);
  if (!body || !Array.isArray(body.data)) {
    throw new HermesClientError(message, 502, "HERMES_RESPONSE_INVALID");
  }
  return body.data;
}
