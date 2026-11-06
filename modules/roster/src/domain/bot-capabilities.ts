import {
  HermesClientError,
  type HermesCapabilityInventory,
  type HermesHostToolsets,
  type HermesHostProfile,
  type HermesMcpInventory,
  type HermesProfileMemory,
  type HermesProfileMemoryWrite,
  type HermesProfileNamedFlag,
  type HermesSkill,
} from "@openedbot/hermes";
import type {
  BotCapabilitiesDto,
  BotMcpServerDto,
  BotRuntimeMemoryDto,
  BotSkillDto,
  BotToolsetDto,
  BotToolUsageDto,
} from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { assertString } from "@openedbot/platform-config/http-body";
import { runtimeToolsetNameIsContractForbidden } from "@openedbot/runtimes/domain/runtime-contract";
import { HOST_SOFTWARE_TOOLSETS } from "@openedbot/runtimes/domain/bot-capabilities";

/** Borne d'une entrée ou d'un fragment sur le fil ; les plafonds du magasin (2 200 / 1 375) sont ceux du runtime. */
const RUNTIME_MEMORY_ENTRY_MAX_CHARS = 2_000;
const CAPABILITY_NAME_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Le nom d'un toolset du profil : bien formé, et pas interdit par le contrat openedbot. */
export function readToolsetName(name: string): string {
  if (!CAPABILITY_NAME_PATTERN.test(name)) throw new HttpError(400, "TOOLSET_INVALID", "Le nom du toolset est invalide.");
  if (runtimeToolsetNameIsContractForbidden(name, { scope: "profile" })) {
    throw new HttpError(403, "TOOLSET_FORBIDDEN", "Ce toolset est interdit par le contrat openedbot.");
  }
  return name;
}

export function readMcpServerName(name: string): string {
  if (!MCP_NAME_PATTERN.test(name)) throw new HttpError(400, "NAME_INVALID", "Le nom du serveur MCP est invalide.");
  return name;
}

export function readSkillName(name: string): string {
  if (!SKILL_NAME_PATTERN.test(name)) throw new HttpError(400, "SKILL_INVALID", "Le nom de la skill est invalide.");
  return name;
}

/** Le nom affiché du profil à créer, ou `null` pour reprendre celui du bot. */
export function readProfileDisplayName(body: Record<string, unknown>): string | null {
  return body.displayName === undefined
    ? null
    : assertString(body.displayName, "Le nom affiché du profil", { max: 120 });
}

/**
 * The model the operator picked for a profile repair, or `null` when the body
 * names none. The catalog check happens later, against the runtime's host.
 */
export function readProfileRepairModel(body: Record<string, unknown>): { model: string; provider: string | null } | null {
  if (body.model === undefined || body.model === null) return null;
  const model = assertString(body.model, "Le modèle", { max: 120 }).trim();
  if (!model) return null;
  const provider = body.provider === undefined || body.provider === null
    ? null
    : assertString(body.provider, "Le fournisseur", { max: 120 }).trim() || null;
  return { model, provider };
}

/** Le corps d'une bascule de capacité : `{ enabled: boolean }`. */
export function readCapabilityEnabled(body: Record<string, unknown>): boolean {
  if (typeof body.enabled !== "boolean") throw new HttpError(400, "BODY_INVALID", "enabled doit être un booléen.");
  return body.enabled;
}

export function profileCapabilityError(error: unknown): HttpError {
  if (error instanceof HermesClientError && error.code === "TOOLSET_FORBIDDEN") {
    return new HttpError(403, "TOOLSET_FORBIDDEN", error.message);
  }
  if (error instanceof HermesClientError && error.status >= 400 && error.status < 500) {
    return new HttpError(error.status, error.code, error.message);
  }
  return new HttpError(502, "HERMES_PROFILE_CAPABILITY_FAILED", "La capacité du profil Hermes n’a pas pu être modifiée.");
}

export function runtimeMemoryDto(memory: HermesProfileMemory): BotRuntimeMemoryDto {
  return {
    available: true,
    profile: memory.profile,
    enabled: memory.memoryEnabled || memory.userProfileEnabled,
    limits: memory.limits,
    entries: memory.entries,
    usedChars: memory.usedChars,
    message: memory.message,
  };
}

/** Une écriture nommée sur la mémoire du runtime : une ligne, une action, une cible. */
export function parseRuntimeMemoryWrite(body: Record<string, unknown>): HermesProfileMemoryWrite {
  const target = body.target;
  const action = body.action;
  if (target !== "memory" && target !== "user") throw new HttpError(400, "VALIDATION_ERROR", "La cible doit être memory ou user.");
  if (action !== "add" && action !== "replace" && action !== "remove") {
    throw new HttpError(400, "VALIDATION_ERROR", "L’action doit être add, replace ou remove.");
  }
  const line = (value: unknown, label: string): string => {
    const text = assertString(value, label, { max: RUNTIME_MEMORY_ENTRY_MAX_CHARS }).replace(/\s+/g, " ").trim();
    if (!text) throw new HttpError(400, "VALIDATION_ERROR", `${label} est vide.`);
    return text;
  };
  if (action === "add") return { action, target, content: line(body.content, "Le fait") };
  if (action === "replace") return { action, target, oldText: line(body.oldText, "L’entrée à corriger"), content: line(body.content, "Le fait") };
  return { action, target, oldText: line(body.oldText, "L’entrée à oublier") };
}

export function profileMcpServers(profile: HermesHostProfile, inventory: HermesMcpInventory | null): BotMcpServerDto[] {
  const details = new Map((inventory?.servers ?? []).map((server) => [server.name, server]));
  return profile.mcpServers.map((flag) => {
    const detail = details.get(flag.name);
    return {
      name: flag.name,
      enabled: flag.enabled,
      transport: detail?.transport ?? null,
      tools: detail?.discoveredTools ?? null,
      unreachable: detail?.unreachable ?? null,
    };
  });
}

/**
 * La réponse du panneau, une fois le runtime interrogé (ou pas).
 *
 * Trois états se ressemblent à l'écran et ne se soignent pas pareil :
 * l'endpoint absent de ce build (`toolsets: null`, aucune erreur), le runtime
 * qu'on n'a pas su lire (`inventoryError` renseigné) et l'organisation sans
 * runtime actif. Les fondre en un `null` unique ferait lire « ce bot n'a
 * aucun outil » là où il fallait lire « je n'ai pas pu regarder ».
 *
 * `usage` traverse les trois : il sort de notre base, un Hermes éteint n'a
 * aucune raison de l'emporter.
 */
export function botCapabilities(input: {
  botId: string;
  hermesProfile: string | null;
  scope?: BotCapabilitiesDto["scope"];
  writable?: boolean;
  profileManagement?: boolean;
  runtimeName: string | null;
  /** `null` = le runtime n'a pas été interrogé (absent, ou lecture échouée). */
  inventory: HermesCapabilityInventory | null;
  /** Ce que l'hôte dit de la disponibilité réelle des toolsets ; `null` : non lu ou non servi. */
  hostToolsets?: HermesHostToolsets | null;
  profileSkills?: HermesProfileNamedFlag[] | null;
  mcpServers?: BotMcpServerDto[] | null;
  failure: unknown;
  usage: BotToolUsageDto[];
  usageWindowDays: number;
}): BotCapabilitiesDto {
  const writable = input.writable ?? false;
  return {
    botId: input.botId,
    hermesProfile: input.hermesProfile,
    scope: input.scope ?? "runtime",
    writable,
    profileManagement: input.profileManagement ?? false,
    runtimeName: input.runtimeName,
    toolsets: overlayAvailability(input.inventory?.toolsets ?? null, input.hostToolsets ?? null),
    skills: overlaySkills(input.inventory?.skills ?? null, input.profileSkills ?? null, writable),
    mcpServers: input.mcpServers ?? null,
    usage: input.usage,
    usageWindowDays: input.usageWindowDays,
    inventoryError: inventoryFailure(input),
  };
}

/**
 * Pose la disponibilité mesurée par l'hôte sur l'inventaire du gateway. Un
 * toolset que l'hôte ne nomme pas (ou tout l'inventaire, avec un edge-setup
 * ancien) reste `available: null`, jamais `true`. The host measures on its
 * root `HERMES_HOME`, without the profile's own keys and terminal backend:
 * measured on the lab (2026-10-25), `file`, `memory`, `vision` and
 * `image_gen` read `check_failed` there while `write_file` works for the bot.
 * So `false` is trusted only for a toolset that needs software on the host
 * itself (`HOST_SOFTWARE_TOOLSETS`); any other stays unknown.
 */
function overlayAvailability(
  toolsets: HermesCapabilityInventory["toolsets"],
  host: HermesHostToolsets | null,
): BotToolsetDto[] | null {
  if (!toolsets) return null;
  const byName = new Map((host?.availability ?? []).map((row) => [row.name, row]));
  return toolsets.map((toolset) => {
    const row = byName.get(toolset.name);
    const available = row?.available === false && !HOST_SOFTWARE_TOOLSETS.has(toolset.name) ? null : row?.available ?? null;
    return {
      ...toolset,
      available,
      unavailableReason: available === false ? row?.reason ?? null : null,
    };
  });
}

function overlaySkills(
  inventory: HermesSkill[] | null,
  profileFlags: HermesProfileNamedFlag[] | null,
  writable: boolean,
): BotSkillDto[] | null {
  if (profileFlags) {
    const extra = new Map((inventory ?? []).map((skill) => [skill.name, skill]));
    return profileFlags.map((flag) => ({
      name: flag.name,
      description: extra.get(flag.name)?.description ?? null,
      category: extra.get(flag.name)?.category ?? null,
      enabled: flag.enabled,
      writable,
    }));
  }
  if (!inventory) return null;
  return inventory.map((skill) => ({
    name: skill.name,
    description: skill.description,
    category: skill.category,
    enabled: true,
    writable: false,
  }));
}

function inventoryFailure(input: {
  inventory: HermesCapabilityInventory | null;
  failure: unknown;
  runtimeName: string | null;
}): BotCapabilitiesDto["inventoryError"] {
  if (input.failure instanceof HermesClientError) {
    return { code: input.failure.code, message: input.failure.message };
  }
  if (input.failure !== null && input.failure !== undefined) {
    return { code: "HERMES_UNREACHABLE", message: "Le runtime Hermes est inaccessible." };
  }
  if (input.inventory) return null;
  return {
    code: "RUNTIME_REQUIRED",
    message: "Aucun runtime Hermes actif : l’inventaire ne peut pas être lu.",
  };
}
