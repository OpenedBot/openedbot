import type {
  HermesProviderCredentialResult,
  HermesProviderOauthSession,
  HermesProviderOauthStatus,
  HermesProviderUsageDocument,
  HermesProviderUsageSnapshot,
  HermesProviderUsageWindow,
  HermesProviderVerification,
} from "../contracts";
import {
  record,
  nullableString,
  invalidProviderResponse,
  PROVIDER_VERIFICATIONS,
  PROVIDER_OAUTH_STATUSES,
} from "./shared";

const PROVIDER_USAGE_SOURCES: ReadonlySet<string> = new Set<HermesProviderUsageSnapshot["source"]>([
  "oauth_usage_api", "usage_api", "credits_api", "unsupported", "unavailable",
]);

export function parseProviderCredentialResult(body: unknown): HermesProviderCredentialResult {
  const bodyRecord = record(body);
  if (
    !bodyRecord
    || typeof bodyRecord.provider !== "string"
    || typeof bodyRecord.label !== "string"
    || typeof bodyRecord.verification !== "string"
    || !PROVIDER_VERIFICATIONS.has(bodyRecord.verification)
    || !nullableString(bodyRecord.detail)
  ) throw invalidProviderResponse();
  return {
    provider: bodyRecord.provider,
    label: bodyRecord.label,
    verification: bodyRecord.verification as HermesProviderVerification,
    detail: bodyRecord.detail,
  };
}

export function parseProviderOauthSession(body: unknown): HermesProviderOauthSession {
  const bodyRecord = record(body);
  if (
    !bodyRecord
    || typeof bodyRecord.sessionId !== "string"
    || typeof bodyRecord.provider !== "string"
    || typeof bodyRecord.status !== "string"
    || !PROVIDER_OAUTH_STATUSES.has(bodyRecord.status)
    || !nullableString(bodyRecord.verificationUri)
    || !nullableString(bodyRecord.userCode)
    || !nullableString(bodyRecord.error)
    || typeof bodyRecord.expiresAt !== "string"
  ) throw invalidProviderResponse();
  return {
    sessionId: bodyRecord.sessionId,
    provider: bodyRecord.provider,
    status: bodyRecord.status as HermesProviderOauthStatus,
    verificationUri: bodyRecord.verificationUri,
    userCode: bodyRecord.userCode,
    error: bodyRecord.error,
    expiresAt: bodyRecord.expiresAt,
  };
}

export function parseProviderUsageDocument(body: unknown): HermesProviderUsageDocument {
  const bodyRecord = record(body);
  if (!bodyRecord || !boundedText(bodyRecord.fetchedAt, 64) || !nullableRfc3339Utc(bodyRecord.fetchedAt) || !Array.isArray(bodyRecord.providers) || bodyRecord.providers.length > 32) {
    throw invalidProviderResponse();
  }
  const providers = bodyRecord.providers.map((raw): HermesProviderUsageSnapshot => {
    const provider = record(raw);
    if (
      !provider
      || !boundedText(provider.provider, 64)
      || typeof provider.source !== "string"
      || !PROVIDER_USAGE_SOURCES.has(provider.source)
      || !nullableString(provider.plan)
      || !Array.isArray(provider.windows)
      || provider.windows.length > 8
      || !Array.isArray(provider.details)
      || provider.details.length > 16
      || !nullableString(provider.unavailableReason)
      || (typeof provider.plan === "string" && provider.plan.length > 200)
      || (typeof provider.unavailableReason === "string" && provider.unavailableReason.length > 200)
      || !provider.details.every((detail) => boundedText(detail, 200))
    ) throw invalidProviderResponse();
    const windows = provider.windows.map((rawWindow): HermesProviderUsageWindow => {
      const window = record(rawWindow);
      if (
        !window
        || !boundedText(window.label, 64)
        || !validUsagePercent(window.usedPercent)
        || !nullableRfc3339Utc(window.resetAt)
        || !nullableString(window.detail)
        || (typeof window.resetAt === "string" && window.resetAt.length > 64)
        || (typeof window.detail === "string" && window.detail.length > 200)
      ) throw invalidProviderResponse();
      return { label: window.label, usedPercent: window.usedPercent, resetAt: window.resetAt, detail: window.detail };
    });
    return {
      provider: provider.provider,
      source: provider.source as HermesProviderUsageSnapshot["source"],
      plan: provider.plan,
      windows,
      details: [...provider.details],
      unavailableReason: provider.unavailableReason,
    };
  });
  return { fetchedAt: bodyRecord.fetchedAt, providers };
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function nullableRfc3339Utc(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validUsagePercent(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);
}
