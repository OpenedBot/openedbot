/**
 * Classification des pannes fournisseur d'inférence.
 *
 * Mesuré le 2026-09-04 sur un VPS de recette : openai-codex a rendu
 * `HTTP 429: The usage limit has been reached`, puis `authenticated: false`
 * dans `/api/model/options`. Un agrégat virtuel (`moa`) est authentifié par
 * construction et ne prouve aucune inférence. Le premier modèle d'un
 * fournisseur gratuit peut répondre 401 « not supported ».
 */

export type ProviderFailureKind = "quota" | "auth" | "model_unsupported" | "other";

/** Agrégats virtuels Hermes : jamais un repli, ils ne prouvent aucune inférence. */
export const VIRTUAL_AGGREGATE_PROVIDERS: ReadonlySet<string> = new Set(["moa"]);

/** HermesClientError codes for a refusal by the gateway, not by the provider behind it. */
const GATEWAY_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "HERMES_LIMIT_REACHED",
  "HERMES_GATEWAY_DRAINING",
  "HERMES_TOKEN_REJECTED",
]);

export const PROVIDER_QUOTA_TTL_HOURS = 6;
export const PROVIDER_AUTH_TTL_HOURS = 24;

export function isVirtualAggregateProvider(slug: string): boolean {
  return VIRTUAL_AGGREGATE_PROVIDERS.has(slug);
}

export function providerIncidentTtlHours(kind: "quota" | "auth"): number {
  return kind === "quota" ? PROVIDER_QUOTA_TTL_HOURS : PROVIDER_AUTH_TTL_HOURS;
}

type InspectedFailure = {
  status: number | null;
  code: string;
  text: string;
};

/**
 * Classe une panne fournisseur à partir d'un `HermesClientError`, d'un
 * événement SSE `run.failed`, d'un `Error`, d'une chaîne ou d'un objet
 * `{message, status, error}`.
 *
 * Ordre : `model_unsupported` (401 « Model … is not supported ») avant
 * `auth`, puis `quota`, puis `auth`, sinon `other`.
 *
 * A refusal by the Hermes gateway itself is never a provider failure
 * (measured 2026-10-23: a gateway 429 "Too many concurrent runs" was
 * recorded as a 6-hour quota on xai-oauth, then on the fallback provider
 * too, and rewrote the bot's profile model). `HERMES_LIMIT_REACHED` is the
 * gateway's concurrent-run cap and clears on its own: the runner requeues
 * the run (`runner/failure.ts`). `HERMES_TOKEN_REJECTED` is openedbot's own
 * gateway bearer: another provider would be refused the same way. A
 * provider's 429 or auth failure reaches openedbot inside the run's events.
 */
export function classifyProviderFailure(error: unknown): ProviderFailureKind {
  const inspected = inspectFailure(error);
  if (GATEWAY_REFUSAL_CODES.has(inspected.code)) return "other";
  const text = inspected.text;
  if (isModelUnsupported(text)) return "model_unsupported";
  if (
    inspected.status === 429
    || /\busage limit\b|\brate limit\b|\bquota\b/i.test(text)
  ) {
    return "quota";
  }
  if (
    inspected.status === 401
    || inspected.status === 403
    || /authentication failed|not authenticated/i.test(text)
    // Mesuré le 04-09 : un login OAuth mort après un 429 fait dire au gateway
    // « No inference provider configured » (ou « No LLM provider configured »),
    // sans 401 : c'est un fournisseur inutilisable, donc un repli, pas « other ».
    || /no (inference|llm) provider configured|provider authentication failed/i.test(text)
  ) {
    return "auth";
  }
  return "other";
}

/**
 * Le fournisseur refuse le modèle demandé pendant un tour.
 *
 * Mesuré : `HTTP 400: Upstream request failed: Model is unavailable.` relayé
 * par Hermes ; OpenAI-compatible : « The model `x` does not exist or you do
 * not have access to it » (`model_not_found`). Le mot « model » est exigé
 * partout : « Service unavailable » ou « upstream unavailable » (panne
 * réseau, 503) ne sont pas un modèle refusé. Un 429 ou un message de quota
 * reste un quota.
 */
export function isModelUnavailableFailure(error: unknown): boolean {
  const inspected = inspectFailure(error);
  const text = inspected.text;
  if (!text) return false;
  if (inspected.status === 429 || GATEWAY_REFUSAL_CODES.has(inspected.code)) return false;
  if (/\busage limit\b|\brate limit\b|\bquota\b/i.test(text)) return false;
  return /\bmodel_not_found\b/i.test(text)
    || /\bmodel\b[^.\n]{0,120}?\b(?:is|are)\s+(?:currently\s+|temporarily\s+)?(?:unavailable|not available)\b/i.test(text)
    || /\bmodel\b[^.\n]{0,120}?\bdoes not exist\b/i.test(text)
    || /\bdo(?:es)? not have access to (?:the |this )?model\b/i.test(text)
    || /\bdoes not exist or you do not have access\b/i.test(text);
}

function isModelUnsupported(text: string): boolean {
  return /\bmodel\b/i.test(text) && /\bis not supported\b/i.test(text);
}

function inspectFailure(error: unknown): InspectedFailure {
  if (typeof error === "string") {
    return { status: statusFromText(error), code: "", text: error };
  }
  if (!error || typeof error !== "object") {
    return { status: null, code: "", text: String(error ?? "") };
  }
  const record = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    error?: unknown;
    errorCode?: unknown;
  };
  const message = pickText(record.message) || pickText(record.error) || "";
  const code = pickText(record.code) || pickText(record.errorCode) || "";
  const status = typeof record.status === "number" && Number.isFinite(record.status)
    ? record.status
    : statusFromText(message);
  return { status, code, text: `${code} ${message}`.trim() };
}

function pickText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function statusFromText(text: string): number | null {
  const match = /\bHTTP\s+(\d{3})\b/i.exec(text) ?? /\b(?:status|code)\s*[:=]\s*(\d{3})\b/i.exec(text);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : null;
}
