import {
  SKILLS_HUB_INSTALL_TIMEOUT_MS,
  SKILLS_HUB_OPERATION_ID_PATTERN,
  SKILLS_HUB_POLL_TIMEOUT_MS,
  SKILLS_HUB_PROFILE_PATTERN,
  SKILLS_HUB_READ_TIMEOUT_MS,
  SKILLS_HUB_SCAN_TIMEOUT_MS,
  type HermesProfileSkillsHubDelete,
  type HermesSkillsHubInspection,
  type HermesSkillsHubOperation,
  type HermesSkillsHubScan,
  type HermesSkillsHubSearchResult,
} from "../contracts";
import { HermesClientError } from "../errors";
import {
  isSkillsHubIdentifier,
  parseProfileSkillsHubDelete,
  parseSkillsHubInspection,
  parseSkillsHubOperation,
  parseSkillsHubScan,
  parseSkillsHubSearch,
} from "../parsers";
import type { HermesClientContext } from "./context";

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const PRINTABLE_QUERY = /[\u0000-\u001F\u007F]/u;

export function skillsHubSearch(
  ctx: HermesClientContext,
  query: string,
  options: { source?: string; limit?: number } = {},
): Promise<HermesSkillsHubSearchResult[]> {
  const normalizedQuery = validateQuery(query);
  return hostPostJson(ctx, "/hermes-setup/skills/hub/search", {
    query: normalizedQuery,
    ...(options.source !== undefined ? { source: validateSource(options.source) } : {}),
    ...(options.limit !== undefined ? { limit: validateLimit(options.limit) } : {}),
  }, SKILLS_HUB_READ_TIMEOUT_MS, parseSkillsHubSearch, "safe");
}

export function skillsHubInspect(ctx: HermesClientContext, identifier: string): Promise<HermesSkillsHubInspection> {
  const normalizedIdentifier = validateIdentifier(identifier);
  return hostPostJson(ctx, "/hermes-setup/skills/hub/inspect", { identifier: normalizedIdentifier }, SKILLS_HUB_READ_TIMEOUT_MS, parseSkillsHubInspection);
}

export function skillsHubScan(ctx: HermesClientContext, profile: string, identifier: string): Promise<HermesSkillsHubScan> {
  const path = profilePath(profile, "/skills/hub/scan");
  return hostPostJson(ctx, path, { identifier: validateIdentifier(identifier) }, SKILLS_HUB_SCAN_TIMEOUT_MS, parseSkillsHubScan);
}

export function skillsHubInstall(ctx: HermesClientContext, profile: string, identifier: string): Promise<{ operationId: string }> {
  const path = profilePath(profile, "/skills/hub/install");
  return hostPostJson(ctx, path, { identifier: validateIdentifier(identifier) }, SKILLS_HUB_INSTALL_TIMEOUT_MS, (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidClientResponse();
    const operationId = (body as Record<string, unknown>).operationId;
    if (typeof operationId !== "string" || !SKILLS_HUB_OPERATION_ID_PATTERN.test(operationId)) throw invalidClientResponse();
    return { operationId };
  });
}

export function skillsHubOperation(ctx: HermesClientContext, profile: string, operationId: string): Promise<HermesSkillsHubOperation> {
  if (!SKILLS_HUB_OPERATION_ID_PATTERN.test(operationId)) throw new HermesClientError("L’identifiant d’opération skill est invalide.", 400, "SKILL_IDENTIFIER_INVALID");
  return hostJson(ctx, `${profilePath(profile, "/skills/hub/operations")}/${encodeURIComponent(operationId)}`, "safe", SKILLS_HUB_POLL_TIMEOUT_MS, parseSkillsHubOperation);
}

export function hostDeleteProfileSkill(ctx: HermesClientContext, profile: string, skill: string): Promise<HermesProfileSkillsHubDelete> {
  validateProfile(profile);
  if (!SKILL_NAME_PATTERN.test(skill) || skill.includes("..") || skill.includes("//") || skill.includes(":")) {
    throw new HermesClientError("Le nom de la skill Hermes est invalide.", 400, "SKILL_IDENTIFIER_INVALID");
  }
  return hostJson(ctx, `${profilePath(profile, "/skills")}/${encodeURIComponent(skill)}`, "mutation", SKILLS_HUB_INSTALL_TIMEOUT_MS, parseProfileSkillsHubDelete, "DELETE");
}

function profilePath(profile: string, suffix: string): string {
  validateProfile(profile);
  return `/hermes-setup/profiles/${encodeURIComponent(profile)}${suffix}`;
}

function validateProfile(profile: string): string {
  if (!SKILLS_HUB_PROFILE_PATTERN.test(profile) || profile === "default") {
    throw new HermesClientError("Le slug de profil Hermes est invalide.", 400, "PROFILE_INVALID");
  }
  return profile;
}

function validateIdentifier(identifier: string): string {
  if (!isSkillsHubIdentifier(identifier)) {
    throw new HermesClientError("L’identifiant de skill est invalide.", 400, "SKILL_IDENTIFIER_INVALID");
  }
  return identifier;
}

function validateQuery(query: string): string {
  if (typeof query !== "string" || query.length < 1 || query.length > 100 || PRINTABLE_QUERY.test(query) || !query.trim()) {
    throw new HermesClientError("La recherche de skills est invalide.", 400, "SKILL_QUERY_INVALID");
  }
  return query;
}

function validateSource(source: string): string {
  if (!SOURCE_PATTERN.test(source)) throw new HermesClientError("La source de skill est invalide.", 400, "SKILL_SOURCE_INVALID");
  return source;
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new HermesClientError("La limite de recherche est invalide.", 400, "SKILL_QUERY_INVALID");
  return limit;
}

async function hostJson<T>(
  ctx: HermesClientContext,
  path: string,
  kind: "safe" | "mutation",
  timeoutMs: number,
  parse: (body: unknown) => T,
  method = "GET",
): Promise<T> {
  const response = await ctx.hostRequest(path, {
    method,
    ...(method === "GET" ? {} : { headers: { "content-type": "application/json" } }),
  }, kind, timeoutMs);
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parse(await ctx.providerJson(response));
}

async function hostPostJson<T>(
  ctx: HermesClientContext,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  parse: (body: unknown) => T,
  kind: "safe" | "mutation" = "mutation",
): Promise<T> {
  const response = await ctx.hostRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, kind, timeoutMs);
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parse(await ctx.providerJson(response));
}

function invalidClientResponse(): HermesClientError {
  return new HermesClientError("L’hôte a renvoyé une réponse skill invalide.", 502, "HERMES_RESPONSE_INVALID");
}
