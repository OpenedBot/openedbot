import type {
  BotCapabilitiesDto,
  BotCapabilityMutationDto,
  BotMcpServerDto,
  BotProfileCredentialDto,
  BotProfileRepairDto,
  BotProfileStatusDto,
  BotRuntimeMemoryDto,
  ToolErrorPageDto,
} from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { HermesCapabilityInventory, HermesHostToolsets, HermesModelOptions, HermesProfileMemoryWrite, HermesProfileNamedFlag } from "@openedbot/hermes";
import type { HostProfileModelSelection } from "@openedbot/portability/application/model";
import { withBotProfileLock } from "@openedbot/portability/application/profile-import-guard";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import {
  botCapabilities,
  profileCapabilityError,
  profileMcpServers,
  runtimeMemoryDto,
} from "../domain/bot-capabilities";
import { publicBot } from "../domain/bot-dto";
import { assertBotProfileReady } from "./profile-provisions";
import { BOT_PROFILE_LOST, botProfileCarried } from "../domain/bot-profile-transfer";
import { botExists, readToolErrors, readToolUsage } from "../sql/bot-activity";
import { readBlockedToolsTx } from "../sql/tool-policies";
import {
  lockBotForProfile,
  markProfileRecreated,
  readBotCapabilityTarget,
  readBotHermesProfile,
  readBotRows,
  readPermissionPipeline,
  readProfileRepairTarget,
  setManagedProfile,
  writeBotApprovalPolicyProof,
} from "../sql/bots";
import {
  createManagedProfile,
  hostProfileState,
  resolvedHostProfileModel,
  type BotDeps,
} from "./bot-host";
import { RELAY_FEATURE_PROFILE_CAPABILITIES, RELAY_FEATURE_PROFILE_CREDENTIALS, RELAY_FEATURE_PROFILE_MANAGEMENT, RELAY_FEATURE_PROFILE_MEMORY, RELAY_FEATURE_TOOLSET_MANAGEMENT } from "@openedbot/contracts-connector/features";

/**
 * Ce que ce bot peut appeler, et ce qu'il a appelé.
 *
 * Deux sources de portée DIFFÉRENTE, jamais fondues : l'inventaire vient du
 * runtime ou du profil nommé quand l'hôte l'annonce ; l'usage vient de nos
 * `run_events` et ne vaut que pour celui-ci. L'écran doit le dire.
 *
 * En lecture pour tout membre : savoir ce qu'un bot peut faire n'est pas une
 * opération d'administration, et le refuser à un membre l'obligerait à le
 * découvrir en le faisant.
 */
export async function readBotCapabilitiesView(
  db: Db,
  deps: BotDeps,
  input: { organizationId: string; botId: string; canWrite: boolean; usageWindowDays: number },
): Promise<BotCapabilitiesDto> {
  const { readRuntime, clientFactory } = deps;
  const { organizationId, botId } = input;
  const found = await withTenant(db, organizationId, async (tx) => {
    const bot = await readBotHermesProfile(tx, organizationId, botId);
    if (!bot) return null;
    return { profile: bot.hermesProfile, usage: await readToolUsage(tx, organizationId, botId) };
  });
  if (!found) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");

  const runtime = await readRuntime(db, organizationId);
  let inventory: HermesCapabilityInventory | null = null;
  let failure: unknown = null;
  let mcpServers: BotMcpServerDto[] | null = null;
  let profileSkills: HermesProfileNamedFlag[] | null = null;
  let hostToolsets: HermesHostToolsets | null = null;
  const profileCapabilities = Boolean(found.profile && runtime?.linkFeatures?.includes(RELAY_FEATURE_PROFILE_CAPABILITIES));
  if (runtime) {
    // Every read leaves at once. On a cold host each operator read starts its
    // own interpreter (1 to 3 s, measured 2026-10-31 on the lab runtime);
    // chained, the screen waited for their sum (4.2 s), together it waits for
    // the slowest. Each one still fails on its own.
    // The toolset availability is best effort: an extra proof whose absence
    // only leaves every toolset `available: null` (not measured).
    const hostToolsetsRead = runtime.linkFeatures?.includes(RELAY_FEATURE_TOOLSET_MANAGEMENT)
      ? clientFactory(runtime.client).hostToolsets().catch(() => null)
      : Promise.resolve(null);
    const profileReads = profileCapabilities
      ? Promise.allSettled([
          clientFactory(runtime.client).hostProfileInventory(),
          clientFactory(runtime.client).mcpInventory(),
        ])
      : null;
    try {
      inventory = await clientFactory({ ...runtime.client, ...(found.profile ? { profile: found.profile } : {}) }).capabilityInventory();
    } catch (error) {
      failure = error;
    }
    hostToolsets = await hostToolsetsRead;
    if (profileReads) {
      const [profiles, mcp] = await profileReads;
      if (profiles.status === "fulfilled") {
        const profile = profiles.value.profiles.find((candidate) => candidate.name === found.profile);
        if (profile) {
          mcpServers = profileMcpServers(profile, mcp.status === "fulfilled" ? mcp.value : null);
          profileSkills = profile.skills;
        }
      }
    }
  }

  return botCapabilities({
    botId,
    hermesProfile: found.profile,
    scope: profileCapabilities ? "profile" : "runtime",
    writable: profileCapabilities && input.canWrite,
    profileSkills,
    profileManagement: Boolean(runtime?.linkFeatures?.includes(RELAY_FEATURE_PROFILE_MANAGEMENT)),
    runtimeName: runtime?.name ?? null,
    inventory,
    hostToolsets,
    mcpServers,
    failure,
    usage: found.usage,
    usageWindowDays: input.usageWindowDays,
  });
}

/** Donne un profil Hermes géré à un bot qui n'en a pas. */
export async function createBotProfile(
  db: Db,
  deps: BotDeps,
  organizationId: string,
  botId: string,
  displayName: string | null,
) {
  const { readRuntime, clientFactory } = deps;
  return withBotProfileLock(db, organizationId, botId, async (db) => {
    await assertBotProfileReady(db, organizationId, botId);
    const runtime = await readRuntime(db, organizationId);
    if (!runtime) throw new HttpError(409, "RUNTIME_REQUIRED", "Enregistrez Hermes avant de créer un profil.");
    if (!runtime.linkFeatures?.includes(RELAY_FEATURE_PROFILE_MANAGEMENT)) {
      throw new HttpError(409, "PROFILE_MANAGEMENT_UNAVAILABLE", "L’hôte Hermes ne gère pas la création de profils.");
    }
    const target = await withTenant(db, organizationId, (tx) => lockBotForProfile(tx, organizationId, botId));
    if (!target) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
    if (target.profile) throw new HttpError(409, "HERMES_PROFILE_ALREADY_SET", "Ce bot possède déjà un profil Hermes.");

    const profileSelection = await resolvedHostProfileModel(
      { model: target.model },
      { selectedProvider: runtime.selectedProvider, selectedModel: runtime.selectedModel },
      () => clientFactory(runtime.client).modelOptions(),
    );
    const pipeline = await withTenant(db, organizationId, (tx) => readPermissionPipeline(tx, organizationId));
    const blocked = await withTenant(db, organizationId, (tx) => readBlockedToolsTx(tx, organizationId, botId));
    let created: Awaited<ReturnType<typeof createManagedProfile>>;
    try {
      created = await createManagedProfile(
        runtime,
        target.slug,
        displayName ?? target.name,
        clientFactory,
        profileSelection ?? undefined,
        target.permissionMode,
        pipeline,
        blocked,
      );
    } catch (error) {
      await withTenant(db, organizationId, (tx) => writeBotApprovalPolicyProof(tx, organizationId, botId, null, false));
      throw error;
    }
    let callbackFailed = false;
    try {
      const bot = await withTenant(db, organizationId, async (tx) => {
        try {
          if (!(await setManagedProfile(tx, organizationId, botId, target.slug))) {
            throw new HttpError(409, "HERMES_PROFILE_ALREADY_SET", "Ce bot possède déjà un profil Hermes.");
          }
          if (created.approvalPolicy) await writeBotApprovalPolicyProof(tx, organizationId, botId, created.approvalPolicy.mode, created.approvalPolicy.effective);
          const rows = await readBotRows(tx, organizationId, botId);
          if (!rows[0]) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
          return publicBot(rows[0]);
        } catch (error) { callbackFailed = true; throw error; }
      });
      return profileSelection ? { ...bot, profileModel: { applied: created.applied } } : bot;
    } catch (error) {
      if (!callbackFailed) throw new HttpError(502, "HERMES_PROFILE_CREATE_FAILED", "Le résultat de la création doit être vérifié.", {}, { unconfirmedProfiles: [target.slug] });
      try { await clientFactory(runtime.client).hostDeleteProfile(target.slug); }
      catch { throw new HttpError(502, "HERMES_PROFILE_CREATE_FAILED", "Le nettoyage du profil doit être vérifié.", {}, { unconfirmedProfiles: [target.slug] }); }
      throw error;
    }
  });
}

// Le bot nomme un profil que le runtime actuel n'a pas (runtime remplacé) :
// l'état le prouve sur l'hôte, le transfert recrée ce qu'openedbot tient en base,
// la réinitialisation repart d'un profil neuf sur le modèle du runtime.
export async function readBotProfileStatus(
  db: Db,
  deps: BotDeps,
  organizationId: string,
  botId: string,
): Promise<BotProfileStatusDto> {
  const { readRuntime, clientFactory } = deps;
  const target = await withTenant(db, organizationId, (tx) => readProfileRepairTarget(tx, organizationId, botId));
  if (!target) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  const runtime = target.profile ? await readRuntime(db, organizationId) : null;
  const state = !target.profile ? "none" : runtime ? await hostProfileState(clientFactory(runtime.client), target.profile) : "unknown";
  const canRepair = state === "missing" && Boolean(runtime?.linkFeatures?.includes(RELAY_FEATURE_PROFILE_MANAGEMENT));
  // Only worth a catalog round trip when a repair is on offer. An unreadable
  // catalog asks for nothing: the repair itself then says what is missing.
  let runtimeHasModel = true;
  if (canRepair && runtime) {
    try { runtimeHasModel = Boolean(await runtimeProfileModel(runtime, catalogLoader(() => clientFactory(runtime.client).modelOptions()))); }
    catch { runtimeHasModel = true; }
  }
  return {
    profile: target.profile,
    state,
    canRepair,
    needsModel: { transfer: !runtimeHasModel && !target.model, reset: !runtimeHasModel },
    carried: botProfileCarried("transfer"),
    lost: [...BOT_PROFILE_LOST],
  } satisfies BotProfileStatusDto;
}

type ProfileModelCatalog = Pick<HermesModelOptions, "providers" | "provider" | "model">;

/** One host catalog read per request, however many resolutions need it. */
function catalogLoader(load: () => Promise<ProfileModelCatalog>): () => Promise<ProfileModelCatalog> {
  let pending: Promise<ProfileModelCatalog> | null = null;
  return () => (pending ??= load());
}

/**
 * The model a new profile gets from the runtime: its own selection, else the
 * host's current default (the "runtime model" the console shows when nothing
 * is selected). `null` when neither is served by an authenticated provider:
 * a profile created then would have no model, and every run of the bot would
 * start without one.
 */
async function runtimeProfileModel(
  runtime: { selectedProvider: string | null; selectedModel: string | null },
  loadCatalog: () => Promise<ProfileModelCatalog>,
): Promise<HostProfileModelSelection | null> {
  const unlessUnavailable = async (resolve: () => Promise<HostProfileModelSelection | null>) => {
    try { return await resolve(); }
    catch (error) {
      if (error instanceof HttpError && error.code === "BOT_MODEL_UNAVAILABLE") return null;
      throw error;
    }
  };
  if (runtime.selectedModel) return unlessUnavailable(() => resolvedHostProfileModel({}, runtime, loadCatalog));
  if (runtime.selectedProvider) return null;
  const catalog = await loadCatalog();
  if (!catalog.model) return null;
  return unlessUnavailable(() => resolvedHostProfileModel({ model: catalog.model, provider: catalog.provider }, {}, async () => catalog));
}

/** Recrée sur le runtime actuel le profil que le bot nomme (`transfer`) ou repart d'un profil neuf (`reset`). */
export async function repairBotProfile(
  db: Db,
  deps: BotDeps,
  organizationId: string,
  botId: string,
  mode: "transfer" | "reset",
  pick: { model: string; provider: string | null } | null = null,
) {
  const { readRuntime, clientFactory } = deps;
  return withBotProfileLock(db, organizationId, botId, async (db) => {
    await assertBotProfileReady(db, organizationId, botId);
    const target = await withTenant(db, organizationId, (tx) => readProfileRepairTarget(tx, organizationId, botId));
    if (!target) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
    if (!target.profile) throw new HttpError(409, "HERMES_PROFILE_REQUIRED", "Ce bot ne possède pas encore de profil Hermes.");
    const runtime = await readRuntime(db, organizationId);
    if (!runtime) throw new HttpError(409, "RUNTIME_REQUIRED", "Enregistrez Hermes avant de recréer un profil.");
    if (!runtime.linkFeatures?.includes(RELAY_FEATURE_PROFILE_MANAGEMENT)) {
      throw new HttpError(409, "PROFILE_MANAGEMENT_UNAVAILABLE", "L’hôte Hermes ne gère pas la création de profils.");
    }
    const state = await hostProfileState(clientFactory(runtime.client), target.profile);
    if (state === "present") throw new HttpError(409, "HERMES_PROFILE_PRESENT", "Ce profil existe déjà sur le runtime actuel : rien à transférer.");
    if (state !== "missing") throw new HttpError(409, "HERMES_PROFILE_STATE_UNKNOWN", "L’absence du profil sur le runtime n’a pas pu être prouvée.");
    const loadCatalog = catalogLoader(() => clientFactory(runtime.client).modelOptions());
    // The operator's pick wins. Otherwise a transfer keeps the bot's own model,
    // refused (BOT_MODEL_UNAVAILABLE) when it is not served here, and the
    // console then offers the reset; a reset, or a bot that followed the
    // runtime, takes the runtime's model.
    const picked = pick ? await resolvedHostProfileModel(pick, {}, loadCatalog) : null;
    const selection = picked
      ?? (mode === "transfer" && target.model ? await resolvedHostProfileModel({ model: target.model }, {}, loadCatalog) : null)
      ?? await runtimeProfileModel(runtime, loadCatalog);
    if (!selection) {
      throw new HttpError(409, "RUNTIME_MODEL_REQUIRED", "Ni le bot ni le runtime ne nomment de modèle servi : choisissez-en un pour recréer le profil.");
    }
    const pipeline = await withTenant(db, organizationId, (tx) => readPermissionPipeline(tx, organizationId));
    const blocked = await withTenant(db, organizationId, (tx) => readBlockedToolsTx(tx, organizationId, botId));
    let created: Awaited<ReturnType<typeof createManagedProfile>>;
    try {
      created = await createManagedProfile(runtime, target.profile, target.name, clientFactory, selection, target.permissionMode, pipeline, blocked);
    } catch (error) {
      await withTenant(db, organizationId, (tx) => writeBotApprovalPolicyProof(tx, organizationId, botId, null, false));
      throw error;
    }
    // A picked model becomes the bot's own: it is the only place the composer
    // and the worker can read it from, since the runtime names none.
    const botModel = picked ? picked.model : mode === "reset" ? null : undefined;
    const bot = await withTenant(db, organizationId, async (tx) => {
      if (!(await markProfileRecreated(tx, organizationId, botId, target.profile!, botModel))) return null;
      if (created.approvalPolicy) await writeBotApprovalPolicyProof(tx, organizationId, botId, created.approvalPolicy.mode, created.approvalPolicy.effective);
      const rows = await readBotRows(tx, organizationId, botId);
      return rows[0] ? publicBot(rows[0]) : null;
    });
    if (!bot) throw new HttpError(502, "HERMES_PROFILE_CREATE_FAILED", "Le profil a été recréé mais le bot n’a pas pu être relu.", {}, { unconfirmedProfiles: [target.profile] });
    const repair: Omit<BotProfileRepairDto, "bot"> = {
      mode,
      profile: target.profile,
      model: selection.model,
      carried: botProfileCarried(mode),
      lost: [...BOT_PROFILE_LOST],
    };
    return { bot, ...repair };
  });
}

/** Le profil du bot et le runtime qui sait le modifier, ou la raison exacte pour laquelle ce n'est pas possible. */
async function readCapabilityContext(
  db: Db,
  deps: BotDeps,
  organizationId: string,
  botId: string,
  feature: string,
  unavailable: { code: string; message: string },
) {
  const target = await withTenant(db, organizationId, (tx) => readBotCapabilityTarget(tx, organizationId, botId));
  if (!target) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  if (!target.profile) throw new HttpError(409, "HERMES_PROFILE_REQUIRED", "Ce bot ne possède pas encore de profil Hermes.");
  const runtime = await deps.readRuntime(db, organizationId);
  if (!runtime || !runtime.linkFeatures?.includes(feature)) {
    throw new HttpError(409, unavailable.code, unavailable.message);
  }
  return { profile: target.profile, runtime };
}

const CAPABILITIES_UNAVAILABLE = {
  code: "PROFILE_CAPABILITIES_UNAVAILABLE",
  message: "L’hôte Hermes ne gère pas les capacités par profil.",
};
const CREDENTIALS_UNAVAILABLE = {
  code: "PROFILE_CREDENTIALS_UNAVAILABLE",
  message: "L’hôte Hermes ne gère pas les clés par profil.",
};

/** Active ou désactive un toolset, un serveur MCP ou une skill du profil du bot. */
export async function setBotCapability(
  db: Db,
  deps: BotDeps,
  organizationId: string,
  botId: string,
  capability: { kind: "toolset" | "mcp" | "skill"; name: string; enabled: boolean },
): Promise<BotCapabilityMutationDto> {
  return withBotProfileLock(db, organizationId, botId, async (db) => {
    await assertBotProfileReady(db, organizationId, botId);
    const { profile, runtime } = await readCapabilityContext(
      db,
      deps,
      organizationId,
      botId,
      RELAY_FEATURE_PROFILE_CAPABILITIES,
      CAPABILITIES_UNAVAILABLE,
    );
    const client = deps.clientFactory(runtime.client);
    try {
      const result = capability.kind === "toolset"
        ? await client.hostSetProfileToolset(profile, capability.name, capability.enabled)
        : capability.kind === "mcp"
          ? await client.hostSetProfileMcpServer(profile, capability.name, capability.enabled)
          : await client.hostSetProfileSkill(profile, capability.name, capability.enabled);
      return result satisfies BotCapabilityMutationDto;
    } catch (error) {
      throw profileCapabilityError(error);
    }
  });
}

/** Pose (`apiKey` donnée) ou retire (`apiKey` absente) la clé d'un fournisseur dans le profil du bot. */
export async function setBotCredential(
  db: Db,
  deps: BotDeps,
  organizationId: string,
  botId: string,
  credential: { provider: string; apiKey: string; label: string | undefined } | { provider: string; remove: true },
): Promise<BotProfileCredentialDto> {
  return withBotProfileLock(db, organizationId, botId, async (db) => {
    await assertBotProfileReady(db, organizationId, botId);
    const { profile, runtime } = await readCapabilityContext(
      db,
      deps,
      organizationId,
      botId,
      RELAY_FEATURE_PROFILE_CREDENTIALS,
      CREDENTIALS_UNAVAILABLE,
    );
    try {
      const client = deps.clientFactory(runtime.client);
      const result = "remove" in credential
        ? await client.hostDeleteProfileCredential(profile, credential.provider)
        : await client.hostSetProfileCredential(profile, credential.provider, credential.apiKey, credential.label);
      return {
        provider: result.provider,
        profile: result.profile,
        verification: result.verification,
        detail: result.detail,
      } satisfies BotProfileCredentialDto;
    } catch (error) {
      throw profileCapabilityError(error);
    }
  });
}

/**
 * La mémoire du RUNTIME d'un bot à profil géré : `MEMORY.md` et `USER.md`
 * du profil, lus par le magasin Hermes sur l'hôte. Pour un tel bot c'est la
 * seule mémoire ; l'écran openedbot l'affiche, l'édite et l'efface par ici.
 */
export async function readBotRuntimeMemory(
  db: Db,
  deps: BotDeps,
  organizationId: string,
  botId: string,
): Promise<BotRuntimeMemoryDto> {
  await assertBotProfileReady(db, organizationId, botId);
  const target = await withTenant(db, organizationId, (tx) => readBotCapabilityTarget(tx, organizationId, botId));
  if (!target) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  if (!target.profile) return { available: false, reason: "no_profile" } satisfies BotRuntimeMemoryDto;
  const runtime = await deps.readRuntime(db, organizationId);
  if (!runtime) return { available: false, reason: "runtime_missing" } satisfies BotRuntimeMemoryDto;
  if (!runtime.linkFeatures?.includes(RELAY_FEATURE_PROFILE_MEMORY)) {
    return { available: false, reason: "feature_missing" } satisfies BotRuntimeMemoryDto;
  }
  try {
    const memory = await deps.clientFactory(runtime.client).hostProfileMemory(target.profile);
    return runtimeMemoryDto(memory);
  } catch (error) {
    throw profileCapabilityError(error);
  }
}

export async function writeBotRuntimeMemory(
  db: Db,
  deps: BotDeps,
  organizationId: string,
  botId: string,
  write: HermesProfileMemoryWrite,
): Promise<BotRuntimeMemoryDto> {
  await assertBotProfileReady(db, organizationId, botId);
  const target = await withTenant(db, organizationId, (tx) => readBotCapabilityTarget(tx, organizationId, botId));
  if (!target) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  if (!target.profile) throw new HttpError(409, "HERMES_PROFILE_REQUIRED", "Ce bot ne possède pas encore de profil Hermes.");
  const runtime = await deps.readRuntime(db, organizationId);
  if (!runtime || !runtime.linkFeatures?.includes(RELAY_FEATURE_PROFILE_MEMORY)) {
    throw new HttpError(409, "PROFILE_MEMORY_UNAVAILABLE", "L’hôte Hermes ne sert pas la mémoire des profils.");
  }
  try {
    const memory = await deps.clientFactory(runtime.client).hostWriteProfileMemory(target.profile, write);
    return runtimeMemoryDto(memory);
  } catch (error) {
    throw profileCapabilityError(error);
  }
}

/**
 * Les derniers échecs d'outils de ce bot (`tool_errors`, 0037), les plus
 * récents d'abord, paginés par curseur `occurredAt|id`. Lisible par tout
 * membre, comme les capacités : savoir ce qui casse n'est pas administrer.
 */
export async function readBotToolErrors(
  db: Db,
  organizationId: string,
  botId: string,
  page: { limit: number; cursor: { occurredAt: string; id: string } | null },
): Promise<ToolErrorPageDto> {
  const found = await withTenant(db, organizationId, async (tx) => {
    if (!(await botExists(tx, organizationId, botId))) return null;
    return readToolErrors(tx, organizationId, botId, page.limit, page.cursor);
  });
  if (!found) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  return found;
}
