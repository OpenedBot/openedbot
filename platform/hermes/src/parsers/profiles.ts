import {
  MCP_NAME_PATTERN,
  PROFILE_SLUG_PATTERN,
  PROVIDER_SLUG_PATTERN,
  SKILL_NAME_PATTERN,
  TOOLSET_KEY_PATTERN,
} from "../contracts";
import type {
  HermesCreatedHostProfile,
  HermesHostProfile,
  HermesProfileAvatar,
  HermesProfileAvatarContentType,
  HermesProfileInventory,
  HermesProfileCredentialResult,
  HermesApprovalPolicyState,
  HermesProfileMcpServerState,
  HermesProfileMcpServerRemoval,
  HermesProfileModelState,
  HermesProfileModelBatchEntry,
  HermesProfileNamedFlag,
  HermesProfileSkillState,
  HermesProfileBundledSkillsState,
  HermesProfileRoutine,
  HermesProfileToolsetState,
  HermesProfileMemory,
  HermesMemoryTarget,
  HermesProfileUiMeta,
  HermesProviderVerification,
} from "../contracts";
import {
  record,
  trimmed,
  nullableString,
  invalidProviderResponse,
  MAX_HOST_LIST,
  PROVIDER_VERIFICATIONS,
} from "./shared";
import { parseToolsetState } from "./capabilities";

/** Provider slug or model id written into a profile `model` block. */
export const PROFILE_MODEL_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const AVATAR_TYPES: ReadonlySet<string> = new Set<HermesProfileAvatarContentType>([
  "image/png", "image/jpeg", "image/webp", "image/gif",
]);
export const MAX_PROFILE_INVENTORY_BYTES = 512 * 1024;
export const MAX_PROFILE_AVATAR_BYTES = 256 * 1024;
const MAX_PROFILES = 32;
const MAX_SOUL_CHARS = 8_000;
const MAX_ROUTINES = 20;

export function parseHostProfileInventory(body: unknown): HermesProfileInventory {
  const bodyRecord = record(body);
  const profiles = bodyRecord?.profiles;
  if (!bodyRecord || !Array.isArray(profiles) || profiles.length > MAX_PROFILES) {
    throw invalidProviderResponse();
  }
  return { profiles: profiles.map(parseHostProfile) };
}

export function parseHostProfileCreateResult(body: unknown): HermesCreatedHostProfile {
  const bodyRecord = record(body);
  if (!bodyRecord || !Object.hasOwn(bodyRecord, "profile")) throw invalidProviderResponse();
  const profile = parseHostProfile(bodyRecord.profile);
  return bodyRecord.readBack === "profile" ? { ...profile, readBack: "profile" } : profile;
}

export function parseHostProfile(value: unknown): HermesHostProfile {
  const row = record(value);
  const name = trimmed(row?.name);
  const displayName = trimmed(row?.displayName);
  if (!row || !name || !PROFILE_SLUG_PATTERN.test(name) || name === "default" || !displayName || displayName.length > 120) {
    throw invalidProviderResponse();
  }
  if (typeof row.hasAvatar !== "boolean") throw invalidProviderResponse();
  const soul = row.soul === null || row.soul === undefined
    ? null
    : (typeof row.soul === "string" && row.soul.length <= MAX_SOUL_CHARS ? row.soul : (() => { throw invalidProviderResponse(); })());
  const title = optionalBoundedText(row.title, 120);
  const description = optionalBoundedText(row.description, 400);
  return {
    name,
    displayName,
    title,
    description,
    soul,
    model: parseProfileModel(row.model),
    uiMeta: row.uiMeta === null || row.uiMeta === undefined ? null : parseProfileUiMeta(row.uiMeta),
    hasAvatar: row.hasAvatar,
    routines: parseProfileRoutineList(row.routines),
    skills: parseNamedFlags(row.skills),
    toolsets: parseNamedFlags(row.toolsets),
    mcpServers: parseNamedFlags(row.mcpServers),
  };
}

function parseProfileModel(value: unknown): HermesHostProfile["model"] {
  const row = record(value);
  if (!row) throw invalidProviderResponse();
  return {
    default: optionalBoundedText(row.default, 200),
    provider: optionalBoundedText(row.provider, 64),
  };
}

function parseProfileUiMeta(value: unknown): HermesProfileUiMeta {
  const row = record(value);
  if (!row || typeof row.hidden !== "boolean" || typeof row.pinned !== "boolean") {
    throw invalidProviderResponse();
  }
  const groups = row.groups;
  if (!Array.isArray(groups) || groups.length > 16) throw invalidProviderResponse();
  const names: string[] = [];
  for (const entry of groups) {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 64) throw invalidProviderResponse();
    names.push(entry.trim());
  }
  return {
    title: optionalBoundedText(row.title, 120),
    color: optionalBoundedText(row.color, 32),
    shape: optionalBoundedText(row.shape, 32),
    imageKind: optionalBoundedText(row.imageKind, 32),
    hidden: row.hidden,
    pinned: row.pinned,
    sectionId: optionalBoundedText(row.sectionId, 64),
    groups: names,
    created: optionalBoundedText(row.created, 40),
  };
}

function parseProfileRoutineList(value: unknown): HermesProfileRoutine[] {
  if (!Array.isArray(value) || value.length > MAX_ROUTINES) throw invalidProviderResponse();
  return value.map((entry) => {
    const row = record(entry);
    const name = trimmed(row?.name);
    if (!row || !name || name.length > 100 || typeof row.schedule !== "string" || row.schedule.length > 120) {
      throw invalidProviderResponse();
    }
    if (typeof row.prompt !== "string" || row.prompt.length > 4_000) throw invalidProviderResponse();
    if (typeof row.enabled !== "boolean" || typeof row.deliver !== "boolean") throw invalidProviderResponse();
    return {
      name,
      schedule: row.schedule,
      prompt: row.prompt,
      enabled: row.enabled,
      deliver: row.deliver,
      model: optionalBoundedText(row.model, 200),
    };
  });
}

function parseNamedFlags(value: unknown): HermesProfileNamedFlag[] {
  if (!Array.isArray(value) || value.length > MAX_HOST_LIST) throw invalidProviderResponse();
  return value.map((entry) => {
    const row = record(entry);
    const name = trimmed(row?.name);
    if (!row || !name || name.length > 64 || typeof row.enabled !== "boolean") throw invalidProviderResponse();
    return { name, enabled: row.enabled };
  });
}

function optionalBoundedText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maxLength) throw invalidProviderResponse();
  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue : null;
}

export function parseHostProfileAvatar(contentType: string, bytes: Uint8Array): HermesProfileAvatar {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (!AVATAR_TYPES.has(type) || bytes.byteLength === 0 || bytes.byteLength > MAX_PROFILE_AVATAR_BYTES) {
    throw invalidProviderResponse();
  }
  return { contentType: type as HermesProfileAvatarContentType, bytes };
}

export function parseProfileToolsetState(body: unknown): HermesProfileToolsetState {
  const bodyRecord = record(body);
  const profile = trimmed(bodyRecord?.profile);
  const name = trimmed(bodyRecord?.name);
  if (
    !profile || !PROFILE_SLUG_PATTERN.test(profile) || profile === "default"
    || !name || !TOOLSET_KEY_PATTERN.test(name)
  ) throw invalidProviderResponse();
  const state = parseToolsetState(body);
  return { ...state, profile };
}

/** Twin of `approvalPolicyToolKeyRe` (`edge-setup/internal/operator/approval_policy.go`). */
export const APPROVAL_POLICY_TOOL_KEY = /^([a-z][a-z0-9_]{0,63}|mcp:[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,128})$/;
export const APPROVAL_POLICY_MAX_BLOCKED_TOOLS = 64;

export function validBlockedTools(keys: readonly unknown[]): keys is string[] {
  return keys.length <= APPROVAL_POLICY_MAX_BLOCKED_TOOLS
    && keys.every((key) => typeof key === "string" && APPROVAL_POLICY_TOOL_KEY.test(key))
    && new Set(keys).size === keys.length;
}

export function parseApprovalPolicyState(body: unknown): HermesApprovalPolicyState {
  const row = record(body);
  if (!row || !["ask_writes", "block_writes", "off"].includes(String(row.mode)) || typeof row.pluginEnabled !== "boolean" || typeof row.effective !== "boolean") {
    throw invalidProviderResponse();
  }
  // Both fields are absent on a host older than PERM2-A: no identity, no
  // blocking. Present but malformed is a broken host, not an old one.
  if (row.gateIdentity !== undefined && typeof row.gateIdentity !== "boolean") throw invalidProviderResponse();
  if (row.blockedTools !== undefined && !(Array.isArray(row.blockedTools) && validBlockedTools(row.blockedTools))) throw invalidProviderResponse();
  return {
    mode: row.mode as HermesApprovalPolicyState["mode"],
    pluginEnabled: row.pluginEnabled,
    effective: row.effective,
    gateIdentity: row.gateIdentity === true,
    blockedTools: Array.isArray(row.blockedTools) ? [...row.blockedTools] as string[] : null,
  };
}

const MEMORY_TARGETS: readonly HermesMemoryTarget[] = ["memory", "user"];
/** Une entrée du magasin amont sur le fil : une ligne, bornée comme côté hôte. */
const MEMORY_ENTRY_MAX_CHARS = 2_000;
const MEMORY_MAX_ENTRIES = 500;

export function parseProfileMemory(body: unknown): HermesProfileMemory {
  const bodyRecord = record(body);
  const profile = trimmed(bodyRecord?.profile);
  if (!profile || !PROFILE_SLUG_PATTERN.test(profile) || profile === "default") throw invalidProviderResponse();
  const limitsRecord = record(bodyRecord?.limits);
  const entriesRecord = record(bodyRecord?.entries);
  const usedRecord = record(bodyRecord?.usedChars);
  if (!limitsRecord || !entriesRecord || !usedRecord) throw invalidProviderResponse();
  const limits = {} as Record<HermesMemoryTarget, number>;
  const entries = {} as Record<HermesMemoryTarget, string[]>;
  const usedChars = {} as Record<HermesMemoryTarget, number>;
  for (const target of MEMORY_TARGETS) {
    const limit = limitsRecord[target];
    const used = usedRecord[target];
    const list = entriesRecord[target];
    if (
      typeof limit !== "number" || !Number.isInteger(limit) || limit < 0
      || typeof used !== "number" || !Number.isInteger(used) || used < 0
      || !Array.isArray(list) || list.length > MEMORY_MAX_ENTRIES
      || list.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > MEMORY_ENTRY_MAX_CHARS)
    ) throw invalidProviderResponse();
    limits[target] = limit;
    usedChars[target] = used;
    entries[target] = list as string[];
  }
  const message = trimmed(bodyRecord?.message);
  return {
    profile,
    memoryEnabled: bodyRecord?.memoryEnabled === true,
    userProfileEnabled: bodyRecord?.userProfileEnabled === true,
    limits,
    entries,
    usedChars,
    message: message ? message.slice(0, 200) : null,
  };
}

export function parseProfileMcpServerState(body: unknown): HermesProfileMcpServerState {
  const bodyRecord = record(body);
  const name = trimmed(bodyRecord?.name);
  const profile = trimmed(bodyRecord?.profile);
  if (
    !bodyRecord
    || !name || !MCP_NAME_PATTERN.test(name)
    || !profile || !PROFILE_SLUG_PATTERN.test(profile) || profile === "default"
    || typeof bodyRecord.enabled !== "boolean"
    || typeof bodyRecord.requested !== "boolean"
  ) throw invalidProviderResponse();
  return {
    name,
    profile,
    enabled: bodyRecord.enabled,
    requested: bodyRecord.requested,
    applied: bodyRecord.enabled === bodyRecord.requested,
  };
}

export function parseProfileMcpServerRemoval(body: unknown): HermesProfileMcpServerRemoval {
  const bodyRecord = record(body);
  const name = trimmed(bodyRecord?.name);
  const profile = trimmed(bodyRecord?.profile);
  if (
    !bodyRecord
    || !name || !MCP_NAME_PATTERN.test(name)
    || !profile || !PROFILE_SLUG_PATTERN.test(profile) || profile === "default"
    || typeof bodyRecord.removed !== "boolean"
    || typeof bodyRecord.tokensRemoved !== "boolean"
  ) throw invalidProviderResponse();
  return { profile, name, removed: bodyRecord.removed, tokensRemoved: bodyRecord.tokensRemoved };
}

export function parseProfileModelState(body: unknown, requested?: { provider: string; model: string }): HermesProfileModelState {
  const bodyRecord = record(body);
  const profile = trimmed(bodyRecord?.profile);
  const provider = trimmed(bodyRecord?.provider);
  const model = trimmed(bodyRecord?.model);
  if (
    !bodyRecord
    || !profile || !PROFILE_SLUG_PATTERN.test(profile) || profile === "default"
    || !provider || !PROFILE_MODEL_TOKEN_PATTERN.test(provider)
    || !model || !PROFILE_MODEL_TOKEN_PATTERN.test(model)
  ) throw invalidProviderResponse();
  return {
    profile,
    provider,
    model,
    applied: requested === undefined
      ? true
      : provider === requested.provider && model === requested.model,
  };
}

/**
 * Une ligne par profil DEMANDÉ, dans l'ordre demandé. Un profil que l'hôte ne
 * rend pas compte comme non appliqué : jamais un succès supposé.
 */
export function parseProfileModelBatch(body: unknown, requested: readonly string[]): HermesProfileModelBatchEntry[] {
  const bodyRecord = record(body);
  if (!bodyRecord || !Array.isArray(bodyRecord.profiles)) throw invalidProviderResponse();
  const answered = new Map<string, HermesProfileModelBatchEntry>();
  for (const raw of bodyRecord.profiles) {
    const entry = record(raw);
    const profile = trimmed(entry?.profile);
    if (!entry || !profile || !PROFILE_SLUG_PATTERN.test(profile) || typeof entry.applied !== "boolean") throw invalidProviderResponse();
    const provider = trimmed(entry.provider);
    const model = trimmed(entry.model);
    const code = trimmed(entry.code);
    answered.set(profile, {
      profile,
      provider: provider && PROFILE_MODEL_TOKEN_PATTERN.test(provider) ? provider : null,
      model: model && PROFILE_MODEL_TOKEN_PATTERN.test(model) ? model : null,
      applied: entry.applied,
      code: code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null,
    });
  }
  return requested.map((profile) => answered.get(profile)
    ?? { profile, provider: null, model: null, applied: false, code: "PROFILE_UNVERIFIED" });
}

export function parseProfileSkillState(body: unknown): HermesProfileSkillState {
  const bodyRecord = record(body);
  const name = trimmed(bodyRecord?.name);
  const profile = trimmed(bodyRecord?.profile);
  if (
    !bodyRecord
    || !name || !SKILL_NAME_PATTERN.test(name)
    || !profile || !PROFILE_SLUG_PATTERN.test(profile) || profile === "default"
    || typeof bodyRecord.enabled !== "boolean"
    || typeof bodyRecord.requested !== "boolean"
  ) throw invalidProviderResponse();
  return {
    name,
    profile,
    enabled: bodyRecord.enabled,
    requested: bodyRecord.requested,
    applied: bodyRecord.enabled === bodyRecord.requested,
  };
}

export function parseProfileBundledSkillsState(body: unknown): HermesProfileBundledSkillsState {
  const bodyRecord = record(body);
  const profile = trimmed(bodyRecord?.profile);
  if (
    !bodyRecord
    || !profile || !PROFILE_SLUG_PATTERN.test(profile) || profile === "default"
    || typeof bodyRecord.requested !== "boolean"
    || typeof bodyRecord.applied !== "boolean"
    || !isCount(bodyRecord.bundled)
    || !isCount(bodyRecord.bundledEnabled)
    || bodyRecord.bundledEnabled > bodyRecord.bundled
  ) throw invalidProviderResponse();
  return {
    profile,
    requested: bodyRecord.requested,
    bundled: bodyRecord.bundled,
    bundledEnabled: bodyRecord.bundledEnabled,
    applied: bodyRecord.applied,
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseProfileCredentialResult(body: unknown): HermesProfileCredentialResult {
  const bodyRecord = record(body);
  const provider = trimmed(bodyRecord?.provider);
  const profile = trimmed(bodyRecord?.profile);
  if (
    !bodyRecord
    || !provider || !PROVIDER_SLUG_PATTERN.test(provider)
    || !profile || !PROFILE_SLUG_PATTERN.test(profile) || profile === "default"
    || typeof bodyRecord.verification !== "string"
    || !PROVIDER_VERIFICATIONS.has(bodyRecord.verification)
    || (bodyRecord.detail !== undefined && !nullableString(bodyRecord.detail))
  ) throw invalidProviderResponse();
  return {
    provider,
    profile,
    verification: bodyRecord.verification as HermesProviderVerification,
    detail: typeof bodyRecord.detail === "string" ? bodyRecord.detail : null,
  };
}
