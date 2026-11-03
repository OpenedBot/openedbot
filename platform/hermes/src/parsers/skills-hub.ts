import {
  SKILLS_HUB_IDENTIFIER_PATTERN,
  SKILLS_HUB_OPERATION_ID_PATTERN,
  SKILLS_HUB_PROFILE_PATTERN,
  type HermesProfileSkillsHubDelete,
  type HermesSkillsHubInspection,
  type HermesSkillsHubFinding,
  type HermesSkillsHubOperation,
  type HermesSkillsHubOperationError,
  type HermesSkillsHubScan,
  type HermesSkillsHubSearchResult,
  type HermesSkillsHubTrustLevel,
} from "../contracts";
import { invalidProviderResponse, record, trimmed } from "./shared";

/**
 * The full skill identifier boundary, twin of `validSkillIdentifier` in
 * `edge-setup/internal/operator/skills_hub.go`: the class, at most 200
 * characters, and no `..`, `//`, `:`, whitespace or control character.
 */
export function isSkillsHubIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200
    && SKILLS_HUB_IDENTIFIER_PATTERN.test(value) && !value.includes("..") && !value.includes("//")
    && !value.includes(":") && !/[\s\u0000-\u001F\u007F]/u.test(value);
}

const TRUST_LEVELS: ReadonlySet<string> = new Set(["official", "trusted", "builtin", "community"]);
const OPERATION_STATES: ReadonlySet<string> = new Set(["queued", "running", "succeeded", "failed"]);
const POLICIES: ReadonlySet<string> = new Set(["allow", "ask", "block"]);
const VERDICTS: ReadonlySet<string> = new Set(["safe", "caution", "dangerous"]);
const FINDING_SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low"]);

/**
 * A malformed document still fails. One upstream row outside the bounded
 * class (an identifier openedbot's routes would refuse, an unknown trust level) is
 * dropped instead: it could not be inspected or installed anyway, and it
 * must not take the rest of the search down with it.
 */
export function parseSkillsHubSearch(body: unknown): HermesSkillsHubSearchResult[] {
  if (!Array.isArray(body) || body.length > 25) throw invalidProviderResponse();
  const results: HermesSkillsHubSearchResult[] = [];
  for (const value of body) {
    const row = record(value);
    if (!row) throw invalidProviderResponse();
    const result = parseSearchResult(row);
    if (result) results.push(result);
  }
  return results;
}

function parseSearchResult(row: Record<string, unknown> | null): HermesSkillsHubSearchResult | null {
  if (!row) return null;
  const name = trimmed(row.name);
  const identifier = trimmed(row.identifier);
  const source = trimmed(row.source);
  const description = typeof row.description === "string" ? row.description : null;
  if (!name || !identifier || !isSkillsHubIdentifier(identifier) || !source || !description || !trustLevel(row.trustLevel)) {
    return null;
  }
  return { name, identifier, source, trustLevel: trustLevel(row.trustLevel)!, description };
}

export function parseSkillsHubInspection(body: unknown): HermesSkillsHubInspection {
  const row = record(body);
  const name = trimmed(row?.name);
  const description = typeof row?.description === "string" ? row.description : null;
  const source = trimmed(row?.source);
  const identifier = trimmed(row?.identifier);
  const tags = row?.tags;
  const preview = row?.skillMdPreview;
  if (
    !name || description === null || !source || !identifier || !isSkillsHubIdentifier(identifier)
    || !Array.isArray(tags) || tags.length > 32
    || tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 64)
    || !(preview === null || (typeof preview === "string" && preview.length <= 64 * 1024))
  ) throw invalidProviderResponse();
  return { name, description, source, identifier, tags: tags.map((tag) => tag.trim()), skillMdPreview: preview as string | null };
}

export function parseSkillsHubScan(body: unknown): HermesSkillsHubScan {
  const row = record(body);
  const source = trimmed(row?.source);
  const verdict = row?.verdict;
  const policy = row?.policy;
  const findings = row?.findings;
  const trust = trustLevel(row?.trustLevel);
  if (!source || !trust || typeof verdict !== "string" || !VERDICTS.has(verdict)
    || typeof policy !== "string" || !POLICIES.has(policy)
    || !Array.isArray(findings) || findings.length > 128
  ) throw invalidProviderResponse();
  return {
    trustLevel: trust,
    source,
    verdict: verdict as HermesSkillsHubScan["verdict"],
    policy: policy as HermesSkillsHubScan["policy"],
    findings: findings.map(parseSkillFinding),
  };
}

function parseSkillFinding(value: unknown): HermesSkillsHubFinding {
  const row = record(value);
  const severity = row?.severity;
  const category = trimmed(row?.category);
  const description = trimmed(row?.description);
  const file = row?.file;
  const line = row?.line;
  if (
    typeof severity !== "string" || !FINDING_SEVERITIES.has(severity)
    || !category || category.length > 1_000
    || !description || description.length > 1_000
    || !(file === null || (typeof file === "string" && file.length > 0 && file.length <= 1_000))
    || !(line === null || (typeof line === "number" && Number.isInteger(line) && line >= 0 && line <= 1_000_000_000))
  ) throw invalidProviderResponse();
  return {
    severity: severity as HermesSkillsHubFinding["severity"],
    category,
    description,
    file: file as string | null,
    line: line as number | null,
  };
}

export function parseSkillsHubOperation(body: unknown): HermesSkillsHubOperation {
  const row = record(body);
  const operationId = trimmed(row?.operationId);
  const profile = trimmed(row?.profile);
  const identifier = trimmed(row?.identifier);
  const state = row?.state;
  const error = row?.error;
  const skills = row?.skills;
  if (
    !operationId || !SKILLS_HUB_OPERATION_ID_PATTERN.test(operationId)
    || !profile || !SKILLS_HUB_PROFILE_PATTERN.test(profile) || profile === "default"
    || !identifier || !isSkillsHubIdentifier(identifier)
    || typeof state !== "string" || !OPERATION_STATES.has(state)
    || !(skills === null || (Array.isArray(skills) && skills.every((skill) => typeof skill === "string" && skill.length <= 256)))
  ) throw invalidProviderResponse();
  return {
    operationId,
    profile,
    identifier,
    state: state as HermesSkillsHubOperation["state"],
    error: parseOperationError(error),
    skills: skills as string[] | null,
  };
}

function parseOperationError(value: unknown): HermesSkillsHubOperationError | null {
  if (value === null) return null;
  const row = record(value);
  const code = trimmed(row?.code);
  const detail = trimmed(row?.detail);
  if (!row || !code || !detail || code.length > 128 || detail.length > 2_000) throw invalidProviderResponse();
  return { code, detail };
}

export function parseProfileSkillsHubDelete(body: unknown): HermesProfileSkillsHubDelete {
  const row = record(body);
  const profile = trimmed(row?.profile);
  const skill = trimmed(row?.skill);
  const skills = row?.skills;
  if (
    !profile || !SKILLS_HUB_PROFILE_PATTERN.test(profile) || profile === "default"
    || !skill || skill.length > 256
    || !Array.isArray(skills) || skills.length > 256
    || skills.some((entry) => typeof entry !== "string" || entry.length > 256)
  ) throw invalidProviderResponse();
  return { profile, skill, skills: skills as string[] };
}

function trustLevel(value: unknown): HermesSkillsHubTrustLevel | null {
  return typeof value === "string" && TRUST_LEVELS.has(value) ? value as HermesSkillsHubTrustLevel : null;
}
