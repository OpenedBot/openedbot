import type {
  HermesModelOptions,
  HermesModelProvider,
  HermesModelContext,
  HermesContextPreamble,
  HermesPreambleBucket,
  HermesPreambleItem,
  HermesPreambleKey,
} from "../contracts";
import { HermesClientError } from "../errors";
import { record, trimmed, nullableString, invalidProviderResponse } from "./shared";

const NON_API_KEY_PROVIDERS = new Set([
  "moa",
  "openai-codex",
  "nous",
  "xai-oauth",
  "qwen-oauth",
  "minimax-oauth",
  "copilot-acp",
  "vertex",
  "bedrock",
]);
const OAUTH_PROVIDERS = new Set(["openai-codex", "nous", "xai-oauth", "qwen-oauth", "minimax-oauth"]);

/**
 * La fenêtre de contexte publiée par l'hôte.
 *
 * Un compte de jetons hors bornes n'est pas un compte de jetons : il devient
 * `0`, c'est-à-dire « inconnue ». Le dénominateur d'une barre de progression
 * ne se devine pas, et un plafond aberrant ferait lire zéro pour cent à
 * n'importe quelle occupation.
 */
export function parseModelContextDocument(body: unknown): HermesModelContext {
  const bodyRecord = record(body);
  if (
    !bodyRecord
    || !nullableString(bodyRecord.model)
    || !nullableString(bodyRecord.provider)
    || (typeof bodyRecord.profile !== "undefined" && !nullableString(bodyRecord.profile))
    || (typeof bodyRecord.model === "string" && bodyRecord.model.length > 200)
    || (typeof bodyRecord.provider === "string" && bodyRecord.provider.length > 64)
    || (typeof bodyRecord.profile === "string" && bodyRecord.profile.length > 64)
  ) throw invalidProviderResponse();
  return {
    profile: typeof bodyRecord.profile === "string" ? bodyRecord.profile : null,
    model: bodyRecord.model,
    provider: bodyRecord.provider,
    autoContextLength: boundedTokenCount(bodyRecord.autoContextLength),
    configContextLength: boundedTokenCount(bodyRecord.configContextLength),
    effectiveContextLength: boundedTokenCount(bodyRecord.effectiveContextLength),
    maxOutputTokens: boundedTokenCount(bodyRecord.maxOutputTokens),
    preamble: parsePreamble(bodyRecord.preamble),
  };
}

const PREAMBLE_KEYS: readonly HermesPreambleKey[] = ["identity", "memory", "skills", "tools", "mcp"];
const MAX_PREAMBLE_ITEMS = 64;
const MAX_PREAMBLE_NAME = 64;

/**
 * Le préambule mesuré par l'hôte. Il est facultatif : un champ abîmé ne fait
 * pas tomber la fenêtre de contexte, il se lit comme absent. `null` reste
 * `null` (« non mesuré ») : un compte inconnu n'est jamais zéro.
 */
function parsePreamble(value: unknown): HermesContextPreamble | null {
  const body = record(value);
  if (!body || !Array.isArray(body.buckets)) return null;
  const byKey = new Map<HermesPreambleKey, HermesPreambleBucket>();
  for (const raw of body.buckets) {
    const bucket = record(raw);
    const key = PREAMBLE_KEYS.find((candidate) => candidate === bucket?.key);
    if (!bucket || !key || byKey.has(key)) continue;
    const items: HermesPreambleItem[] = [];
    for (const rawItem of Array.isArray(bucket.items) ? bucket.items : []) {
      if (items.length >= MAX_PREAMBLE_ITEMS) break;
      const item = record(rawItem);
      const name = typeof item?.name === "string" ? item.name.trim().slice(0, MAX_PREAMBLE_NAME) : "";
      if (name) items.push({ name, tokens: optionalTokenCount(item!.tokens) });
    }
    byKey.set(key, { key, tokens: optionalTokenCount(bucket.tokens), items });
  }
  return { buckets: PREAMBLE_KEYS.flatMap((key) => byKey.get(key) ?? []) };
}

/** Un compte de jetons plausible, zéro compris, ou `null` (« non mesuré »). */
function optionalTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const count = Math.floor(value);
  return count >= 0 && count <= 16_000_000 ? count : null;
}

/** Le même plafond que `MaxContextWindow` côté hôte : 16 M, ou zéro. */
function boundedTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const count = Math.floor(value);
  return count > 0 && count <= 16_000_000 ? count : 0;
}

export function normalizeHermesModelOptions(input: unknown): HermesModelOptions {
  if (!input || typeof input !== "object") {
    throw new HermesClientError("Le catalogue Hermes est invalide.", 502, "HERMES_RESPONSE_INVALID");
  }
  const body = input as { provider?: unknown; model?: unknown; providers?: unknown };
  if (!Array.isArray(body.providers)) {
    throw new HermesClientError("Le catalogue Hermes est invalide.", 502, "HERMES_RESPONSE_INVALID");
  }
  const provider = trimmed(body.provider);
  const model = trimmed(body.model);
  const providers = body.providers.map((raw): HermesModelProvider => {
    if (!raw || typeof raw !== "object") {
      throw new HermesClientError("Un fournisseur Hermes est invalide.", 502, "HERMES_RESPONSE_INVALID");
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.slug !== "string" || typeof item.name !== "string") {
      throw new HermesClientError("Un fournisseur Hermes est invalide.", 502, "HERMES_RESPONSE_INVALID");
    }
    const capabilities = item.capabilities && typeof item.capabilities === "object"
      ? item.capabilities as Record<string, unknown>
      : {};
    const models = Array.isArray(item.models)
      ? [...new Set(item.models.filter((value): value is string => typeof value === "string" && Boolean(value.trim())))]
      : [];
    const authenticated = typeof item.authenticated === "boolean" ? item.authenticated : models.length > 0;
    const authType = typeof item.auth_type === "string" ? item.auth_type : null;
    return {
      slug: item.slug,
      name: item.name,
      isCurrent: item.slug === provider || item.is_current === true,
      authenticated,
      authType,
      warning: typeof item.warning === "string" ? item.warning : null,
      models: models.map((id) => {
        const detail = record(capabilities[id]) ?? {};
        return { id, fast: detail.fast === true, reasoning: detail.reasoning === true };
      }),
    };
  });
  return { provider, model, providers };
}

export function hermesProviderAcceptsApiKey(provider: HermesModelProvider): boolean {
  if (provider.authType !== null) return provider.authType === "api_key";
  return !NON_API_KEY_PROVIDERS.has(provider.slug) && !provider.slug.includes("oauth");
}

export function hermesProviderAcceptsOauth(provider: HermesModelProvider): boolean {
  if (provider.authType !== null) return provider.authType.startsWith("oauth");
  return OAUTH_PROVIDERS.has(provider.slug) || provider.slug.includes("oauth");
}
