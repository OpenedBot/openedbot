import { createManagedProfile as provisionManagedProfile } from "@openedbot/portability/application/provision";
import { asProfileHttpError } from "@openedbot/portability/application/profile-import-guard";
import {
  resolvedHostProfileModel as resolveProfileModel,
  type HostProfileModelSelection,
} from "@openedbot/portability/application/model";
import { ProfileImportError } from "@openedbot/portability/domain/errors";
import {
  HermesClient,
  HermesClientError,
  type HermesClientConfig,
  type HermesHostProfileCreateOptions,
  type HermesModelOptions,
} from "@openedbot/hermes";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { BotPermissionMode } from "@openedbot/contracts-api";
import type { PermissionPipelineId } from "@openedbot/runtimes/domain/runtime-contract";
import { applyHostApprovalPolicy } from "./approval-policy";
import type { HermesApprovalPolicyState } from "@openedbot/hermes";
import { PROFILE_MANAGEMENT_FEATURE } from "../domain/bot-capabilities";
import { readRegisteredRuntimeForCleanup, readRuntimeSecret, type RuntimeAccessConfig } from "@openedbot/runtimes/application/runtime-access";
import type { Db } from "@openedbot/platform-db";

export type BotRouteClient = Pick<
  HermesClient,
  | "capabilityInventory"
  | "modelOptions"
  | "hostCreateProfile"
  | "hostDeleteProfile"
  | "hostProfileInventory"
  | "hostDeleteProfileCredential"
  | "hostSetProfileCredential"
  | "hostSetProfileMcpServer"
  | "hostSetProfileModel"
  | "hostSetProfileModels"
  | "hostSetProfileSkill"
  | "hostSetProfileToolset"
  | "hostToolsets"
  | "hostSetApprovalPolicy"
  | "hostApprovalPolicy"
  | "hostProfileMemory"
  | "hostWriteProfileMemory"
  | "mcpInventory"
  | "probeProfileIsolation"
  | "deleteSession"
>;

/** Le runtime actif d'une organisation et le client qui le joint, tels que `readRuntimeSecret` les rend. */
export type BotRuntime = NonNullable<Awaited<ReturnType<typeof readRuntimeSecret>>>;

/** Ce que les routes (et les tests) peuvent substituer : la lecture du runtime et la fabrique de client. */
export type BotRouteDeps = {
  readRuntime?: typeof readRuntimeSecret;
  readRuntimeForDeletion?: typeof readRegisteredRuntimeForCleanup;
  clientFactory?: (clientConfig: HermesClientConfig) => BotRouteClient;
};

/** Les dépendances d'un cas d'usage du roster, la configuration de l'API déjà liée. */
export type BotDeps = {
  readRuntime: (db: Db, organizationId: string) => Promise<BotRuntime | null>;
  readRuntimeForDeletion: (db: Db, organizationId: string) => Promise<{ id: string; linkFeatures: string[] } | null>;
  clientFactory: (clientConfig: HermesClientConfig) => BotRouteClient;
};

/** Lie la configuration de l'API aux dépendances substituables ; le défaut est le vrai runtime et `HermesClient`. */
export function resolveBotDeps(config: RuntimeAccessConfig, deps: BotRouteDeps = {}): BotDeps {
  const readRuntime = deps.readRuntime ?? readRuntimeSecret;
  return {
    readRuntime: (db, organizationId) => readRuntime(db, config, organizationId),
    readRuntimeForDeletion: deps.readRuntimeForDeletion ?? readRegisteredRuntimeForCleanup,
    clientFactory: deps.clientFactory ?? ((clientConfig: HermesClientConfig) => new HermesClient(clientConfig)),
  };
}

export async function createManagedProfile(
  runtime: { client: HermesClientConfig; linkFeatures?: readonly string[] | null },
  slug: string,
  displayName: string,
  clientFactory: (clientConfig: HermesClientConfig) => BotRouteClient,
  selection: HermesHostProfileCreateOptions | undefined,
  permissionMode: BotPermissionMode,
  pipeline: PermissionPipelineId,
  /** PERM2-5: the bot's stored blocked keys, written with the policy. */
  blockedTools?: readonly string[],
): Promise<{ applied: boolean; approvalPolicy?: HermesApprovalPolicyState }> {
  try {
    const created = await provisionManagedProfile(runtime, slug, displayName, clientFactory, selection);
    const approvalPolicy = await applyHostApprovalPolicy(runtime, slug, permissionMode, pipeline, clientFactory, blockedTools);
    return { ...created, ...(approvalPolicy ? { approvalPolicy } : {}) };
  }
  catch (error) { throw asProfileHttpError(error); }
}

/** Le modèle à écrire dans le profil hôte, refus du contrat traduits en `HttpError`. */
export async function resolvedHostProfileModel(
  bot: { model?: string | null; provider?: string | null },
  runtime: { selectedProvider?: string | null; selectedModel?: string | null },
  loadCatalog: () => Promise<Pick<HermesModelOptions, "providers">>,
): Promise<HostProfileModelSelection | null> {
  try { return await resolveProfileModel(bot, runtime, loadCatalog); }
  catch (error) {
    if (error instanceof ProfileImportError) throw new HttpError(error.status, error.code, error.message);
    throw error;
  }
}

function hostProfileHttpError(error: unknown, unverifiedMessage: string): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof HermesClientError) {
    return new HttpError(
      error.status >= 400 && error.status < 500 ? error.status : 502,
      error.code === "PROFILE_NOT_FOUND" ? "PROFILE_NOT_FOUND" : "HERMES_PROFILE_DELETE_FAILED",
      error.message,
    );
  }
  return new HttpError(502, "HERMES_PROFILE_DELETE_FAILED", unverifiedMessage);
}

/**
 * Efface un profil nommé sur l'hôte et le relit. Absent (déjà parti) : succès.
 * Encore présent après DELETE : le bot n'est pas mis à la corbeille.
 */
export async function removeNamedHostProfile(
  runtime: { client: HermesClientConfig },
  slug: string,
  clientFactory: (clientConfig: HermesClientConfig) => BotRouteClient,
): Promise<"deleted" | "already_absent"> {
  const client = clientFactory(runtime.client);
  const unverified = "Le profil Hermes n’a pas pu être effacé sur l’hôte. Le bot n’a pas été mis à la corbeille.";
  let inventory;
  try {
    inventory = await client.hostProfileInventory();
  } catch (error) {
    throw hostProfileHttpError(error, unverified);
  }
  if (!inventory.profiles.some((profile) => profile.name === slug)) {
    return "already_absent";
  }
  try {
    await client.hostDeleteProfile(slug);
  } catch (error) {
    if (error instanceof HermesClientError && error.code === "PROFILE_NOT_FOUND") {
      return "already_absent";
    }
    throw hostProfileHttpError(error, unverified);
  }
  let after;
  try {
    after = await client.hostProfileInventory();
  } catch (error) {
    throw hostProfileHttpError(error, unverified);
  }
  if (after.profiles.some((profile) => profile.name === slug)) {
    throw new HttpError(
      502,
      "PROFILE_UNVERIFIED",
      "L’hôte n’a pas confirmé la suppression de ce profil. Le bot n’a pas été mis à la corbeille.",
    );
  }
  return "deleted";
}

export async function ensureHostProfileForRestore(
  runtime: { client: HermesClientConfig; linkFeatures?: readonly string[] | null } | null,
  slug: string,
  displayName: string,
  clientFactory: (clientConfig: HermesClientConfig) => BotRouteClient,
  permissionMode: BotPermissionMode,
  pipeline: PermissionPipelineId,
  blockedTools?: readonly string[],
): Promise<HermesApprovalPolicyState | null> {
  if (!runtime) {
    throw new HttpError(
      409,
      "RUNTIME_REQUIRED",
      "Enregistrez Hermes avant de restaurer ce bot : son profil doit exister sur l’hôte.",
    );
  }
  if (!runtime.linkFeatures?.includes(PROFILE_MANAGEMENT_FEATURE)) {
    throw new HttpError(
      409,
      "PROFILE_MANAGEMENT_UNAVAILABLE",
      "L’hôte Hermes ne gère pas la création de profils.",
    );
  }
  const client = clientFactory(runtime.client);
  let inventory;
  try {
    inventory = await client.hostProfileInventory();
  } catch (error) {
    throw hostProfileHttpError(
      error,
      "L’inventaire des profils Hermes n’a pas pu être lu. Le bot n’a pas été restauré.",
    );
  }
  if (inventory.profiles.some((profile) => profile.name === slug)) {
    return applyHostApprovalPolicy(runtime, slug, permissionMode, pipeline, clientFactory, blockedTools);
  }
  const created = await createManagedProfile(runtime, slug, displayName, clientFactory, undefined, permissionMode, pipeline, blockedTools);
  return created.approvalPolicy ?? null;
}

/** Ce que l'hôte prouve du profil : un 404 sous `/p/<slug>/` avec un témoin muet dit « absent ». */
export async function hostProfileState(
  client: Pick<BotRouteClient, "probeProfileIsolation">,
  profile: string,
): Promise<"present" | "missing" | "unknown"> {
  try {
    const isolation = await client.probeProfileIsolation(profile);
    return isolation === "isolated" ? "present" : isolation === "missing" ? "missing" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Efface, sur le runtime du client, les sessions que ce bot y possédait.
 *
 * Sérielle, et sans repli : un runtime injoignable doit être *lent une fois*,
 * pas N fois. Chaque session est indépendante : un échec sur l'une n'empêche
 * pas d'effacer les autres, et le compte des échecs décide seul si la purge
 * peut aller jusqu'à la ligne SQL.
 *
 * Le profil est celui du bot : une session créée sous `/p/<slug>` ne se
 * supprime que sous ce même préfixe. Une session qui n'a jamais existé (la
 * passe mémoire n'a peut-être jamais tourné) répond 404, et
 * `HermesClient.deleteSession` en fait un succès : demander l'effacement de
 * ce qui n'est pas là ne doit pas bloquer la purge.
 */

export async function purgeRuntimeSessions(
  runtime: { client: HermesClientConfig } | null,
  profile: string | null,
  sessions: ReadonlyArray<string>,
  clientFactory: (clientConfig: HermesClientConfig) => Pick<HermesClient, "deleteSession"> = (clientConfig) => new HermesClient(clientConfig),
): Promise<{ deleted: number; failed: string[]; reason: string | null }> {
  if (!runtime) {
    return {
      deleted: 0,
      failed: [...sessions],
      reason: "Aucun runtime Hermes n’est enregistré : les sessions de ce bot n’ont pas pu être effacées à distance.",
    };
  }
  const client = clientFactory({ ...runtime.client, ...(profile ? { profile } : {}) });
  let deleted = 0;
  const failed: string[] = [];
  let reason: string | null = null;
  for (const sessionId of sessions) {
    try {
      await client.deleteSession(sessionId);
      deleted += 1;
    } catch (error) {
      failed.push(sessionId);
      reason ??= error instanceof HermesClientError
        ? `Hermes a refusé d’effacer une session de ce bot : ${error.message}`
        : "Une session de ce bot n’a pas pu être effacée sur le runtime.";
    }
  }
  return { deleted, failed, reason };
}
