import { createHash } from "node:crypto";
import { HermesClientError } from "@openedbot/hermes";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { withBotProfileLock, withProfileNamesLock } from "@openedbot/portability/application/profile-import-guard";
import { applyHostProfileModel } from "@openedbot/portability/application/model";
import { readOrganizationCursor } from "@openedbot/conversation/sql/organization-cursor";
import { cancelMaintenanceRunsTx, isMaintenanceStepKind } from "@openedbot/execution/application/run-cancellation";
import { botGreetingInput } from "@openedbot/execution/domain/bot-greeting";
import { greetNewBotTx } from "@openedbot/execution/application/run-creation";
import { readOperatorProfile } from "@openedbot/identity/sql/operator-profile";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { isUniqueViolation, withTenant } from "@openedbot/platform-db";
import { botRuntimeSessionIds, namedHostProfileSlug } from "../domain/bot-deletion";
import { readModelAssignmentMode } from "@openedbot/runtimes/application/runtime-mode";
import { applyHostApprovalPolicy, applyTighteningPolicyBeforeMutation, approvalPolicyWriteMustPrecedeCommit } from "./approval-policy";
import { publicBot, type BotRow } from "../domain/bot-dto";
import { assertPermissionModeUnderCeiling } from "./permission-ceiling";
import type { CreateBotInput, UpdateBotInput } from "../domain/bot-input";
import { chooseBotSlug } from "./bot-slug";
import {
  deleteBotRow,
  hasPendingBotIngress,
  insertBotWithThread,
  isBotInGroup,
  lockActiveBotRuns,
  lockBotRow,
  nextBotPosition,
  nextBotPositionExcluding,
  readActiveBotRuns,
  readBotCreationReplay,
  readBotDeletionScope,
  readBotRestoreTarget,
  readBotRows,
  readPermissionPipeline,
  defaultPermissionMode,
  readRosterBots,
  softDeleteBot,
  updateBotRow,
  writeBotApprovalPolicyProof,
} from "../sql/bots";
import { detachBotFromGroups } from "../sql/bot-purge";
import { readGroups } from "../sql/groups";
import { pruneEmptySections } from "../sql/section-prune";
import { insertDefaultSection, readDefaultSectionId, readSections, sectionExists } from "../sql/sections";
import { insertProfileProvision } from "../sql/profile-provisions";
import { insertBotHostCleanup } from "../sql/bot-host-cleanups";
import { readBlockedToolsTx } from "../sql/tool-policies";
import { lockBotHostCleanupForRestore } from "./bot-host-cleanups";
import { assertBotProfileReady, assertBotProfileSettled, assertProvisionRestorable, cancelProfileProvision, closeProvisionAfterRestore } from "./profile-provisions";
import {
  createManagedProfile,
  ensureHostProfileForRestore,
  resolvedHostProfileModel,
  type BotDeps,
} from "./bot-host";
import { RELAY_FEATURE_APPROVAL_POLICY, RELAY_FEATURE_PROFILE_CAPABILITIES, RELAY_FEATURE_PROFILE_MANAGEMENT } from "@openedbot/contracts-connector/features";

export { resolveBotDeps } from "./bot-host";
export type { BotDeps, BotRouteDeps, BotRouteClient } from "./bot-host";

/** Le roster de l'organisation : sections, bots, salons, handle de l'opérateur et curseur du flux. */
export async function listRoster(db: Db, organizationId: string, userId: string, includeHidden: boolean) {
  return withTenant(db, organizationId, async (tx) => {
    // EN PREMIER : borne basse sûre du flux, voir `readOrganizationCursor`.
    // Le client s'en sert pour ignorer un événement que ce roster reflète
    // déjà (curseur ≤) sans comparer des horloges.
    const cursor = await readOrganizationCursor(tx, organizationId);
    const sections = await readSections(tx, organizationId);
    const bots = await readRosterBots(tx, organizationId, userId, includeHidden);
    const [groups, operator] = await Promise.all([
      readGroups(tx, organizationId, undefined, userId, includeHidden),
      readOperatorProfile(tx, organizationId),
    ]);
    return {
      sections,
      bots: bots.map(publicBot),
      groups,
      operator,
      cursor,
    };
  });
}

/**
 * La création d'un bot (`POST /api/bots`), partagée avec la Marketplace :
 * un modèle d'agent crée son bot par ce même chemin, profil géré compris
 * (ADR Marketplace §4). Le rôle est vérifié par l'appelant.
 *
 * Profil géré : par défaut (`async`), le bot et sa demande de profil sont
 * écrits ensemble et le worker crée le profil sur l'hôte (8 s mesurées sur
 * le lab) ; ses runs attendent qu'il soit prouvé. `sync` garde l'attente :
 * la Marketplace écrit les capacités du modèle dans le profil juste après.
 */
export type ProfileProvisioning = "async" | "sync";

/** What `createBot` answers; `creationReplayed` only on a replayed request id. */
export type CreatedBot = ReturnType<typeof publicBot> & {
  profileModel?: { applied: boolean };
  creationReplayed?: true;
};

/** The digest stored with a creation request id (0136). */
function creationRequestDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * The bot an earlier attempt with this request id created (0135). A request
 * whose bot was deleted since is refused rather than replayed into the
 * archives, or silently turned into a second bot; a request id sent again
 * with another body (renamed bot, edited persona) is refused rather than
 * answered with a bot that does not match it (0136).
 */
async function readCreationReplay(
  db: Db,
  organizationId: string,
  requestId: string,
  requestDigest: string | null,
): Promise<CreatedBot | null> {
  return withTenant(db, organizationId, async (tx) => {
    const found = await readBotCreationReplay(tx, organizationId, requestId);
    if (!found) return null;
    if (found.deleted) {
      throw new HttpError(409, "BOT_CREATION_REQUEST_CONSUMED", "Le bot de cette demande a été supprimé depuis. Recommencez la création.");
    }
    // A row created before 0136 has no digest: it replays as it did.
    if (found.digest !== null && requestDigest !== null && found.digest !== requestDigest) {
      throw new HttpError(409, "BOT_CREATION_REQUEST_REUSED", "Cette demande de création a déjà servi pour un autre bot. Recommencez la création.");
    }
    const rows = await readBotRows(tx, organizationId, found.botId);
    return rows[0] ? { ...publicBot(rows[0]), creationReplayed: true as const } : null;
  });
}

/**
 * Written in the transaction that inserts the bot, after the row exists: a
 * bot is committed only with what this callback writes (a Marketplace
 * template's playbooks and routines), never without it.
 */
export type CreateBotAfterInsert = (tx: TransactionDb, bot: { id: string; threadId: string }) => Promise<void>;

export async function createBot(
  db: Db,
  deps: BotDeps,
  organizationId: string,
  input: CreateBotInput,
  options: {
    profileProvisioning?: ProfileProvisioning;
    greeting?: { initiatorUserId: string };
    afterInsert?: CreateBotAfterInsert;
  } = {},
): Promise<CreatedBot> {
  const { readRuntime, clientFactory } = deps;
  const { name, profile } = input;
  let slug = input.slug;
  const requestDigest = input.clientRequestId && input.clientRequestKey ? creationRequestDigest(input.clientRequestKey) : null;
  // A replay answers first, even without a runtime: the operator only lost the first response.
  if (input.clientRequestId) {
    const replayed = await readCreationReplay(db, organizationId, input.clientRequestId, requestDigest);
    if (replayed) return replayed;
  }
  // D-1: no explicit mode takes the organization's default, itself under the ceiling.
  if (input.editor.permissionMode === undefined) {
    const permissionMode = await withTenant(db, organizationId, (tx) => defaultPermissionMode(tx, organizationId));
    input = { ...input, editor: { ...input.editor, permissionMode } };
  }
  // PERM2-8: refused before any host call, so a refusal leaves nothing behind.
  await assertPermissionModeUnderCeiling(db, organizationId, input.editor.permissionMode ?? "manual", null);
  const runtime = await readRuntime(db, organizationId);
  if (!runtime) throw new HttpError(409, "RUNTIME_REQUIRED", "Enregistrez Hermes avant de créer un bot.");
  const managedProfile = profile === null && runtime.linkFeatures?.includes(RELAY_FEATURE_PROFILE_MANAGEMENT) === true;
  const provisionLater = managedProfile && (options.profileProvisioning ?? "async") === "async";
  return withProfileNamesLock(db, organizationId, profile ? [profile] : [], async (db) => {
  // The org-wide names lock: a racing replay sees its row here, before any host call.
  if (input.clientRequestId) {
    const replayed = await readCreationReplay(db, organizationId, input.clientRequestId, requestDigest);
    if (replayed) return replayed;
  }
  slug = await chooseBotSlug(db, organizationId, input);
  if (profile !== null) {
    // On ne vérifie QUE ce que l'opérateur a demandé. `not_partitioned` n'est
    // pas une erreur : c'est la configuration par défaut d'un runtime, et
    // refuser la création apprendrait à l'opérateur à ne plus renseigner de
    // profil : exactement ce qu'il aurait dû faire dès le départ.
    try {
      const isolation = await clientFactory({ ...runtime.client, profile }).probeProfileIsolation(profile);
      if (isolation === "missing") {
        throw new HttpError(
          404,
          "HERMES_PROFILE_MISSING",
          `Le profil Hermes « ${profile} » n’existe pas sur ce runtime. Créez-le, ou laissez le champ vide.`,
        );
      }
    } catch (error) {
      if (error instanceof HermesClientError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  const profileSelection = await resolvedHostProfileModel(
    { model: input.model, provider: input.provider },
    { selectedProvider: runtime.selectedProvider, selectedModel: runtime.selectedModel },
    () => clientFactory(runtime.client).modelOptions(),
  );
  let profileModel: { applied: boolean } | undefined;
  let approvalPolicy: Awaited<ReturnType<typeof createManagedProfile>>["approvalPolicy"];
  if (managedProfile && !provisionLater) {
    const pipeline = await withTenant(db, organizationId, (tx) => readPermissionPipeline(tx, organizationId));
    const created = await createManagedProfile(runtime, slug, name, clientFactory, profileSelection ?? undefined, input.editor.permissionMode ?? "manual", pipeline);
    approvalPolicy = created.approvalPolicy;
    if (profileSelection) profileModel = created;
  }

  let callbackFailed = false;
  const bot = await withTenant(db, organizationId, async (tx) => {
    try {
    let sectionId = input.sectionId;
    if (!sectionId) {
      const firstSectionId = await readDefaultSectionId(tx, organizationId);
      sectionId = firstSectionId ?? crypto.randomUUID();
      if (!firstSectionId) await insertDefaultSection(tx, organizationId, sectionId);
    }
    const position = await nextBotPosition(tx, organizationId, sectionId);
    const id = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    await insertBotWithThread(tx, {
      id,
      threadId,
      organizationId,
      sectionId,
      name,
      slug,
      description: input.description,
      instructions: input.instructions,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      hermesProfile: managedProfile ? slug : profile,
      hermesProfileManaged: managedProfile,
      position,
      face: input.face,
      voiceId: input.voiceId,
      autonomy: input.autonomy,
      editor: input.editor,
      creationRequestId: input.clientRequestId,
      creationRequestDigest: requestDigest,
    });
    if (approvalPolicy) await writeBotApprovalPolicyProof(tx, organizationId, id, approvalPolicy.mode, approvalPolicy.effective);
    if (provisionLater) {
      await insertProfileProvision(tx, {
        botId: id,
        organizationId,
        runtimeId: runtime.id,
        slug,
        displayName: name,
        provider: profileSelection?.provider ?? null,
        model: profileSelection?.model ?? null,
      });
    }
    if (options.greeting && input.greet) {
      await greetNewBotTx(tx, {
        organizationId,
        threadId,
        botId: id,
        initiatorUserId: options.greeting.initiatorUserId,
        input: botGreetingInput({
          name,
          role: input.description,
          mission: input.mission,
          replyLanguage: input.editor.replyLanguage ?? "auto",
          operatorLocale: input.operatorLocale,
        }),
      });
    }
    if (options.afterInsert) await options.afterInsert(tx, { id, threadId });
    const rows = await readBotRows(tx, organizationId, id);
    return publicBot(rows[0]!);
    } catch (error) { callbackFailed = true; throw error; }
  }).catch(async (error) => {
    // Profil créé en synchrone puis insert raté : on le retire de l'hôte.
    const synchronousProfile = managedProfile && !provisionLater;
    const unconfirmed: string[] = [];
    if (synchronousProfile && callbackFailed) {
      try { await clientFactory(runtime.client).hostDeleteProfile(slug); } catch { unconfirmed.push(slug); }
    } else if (synchronousProfile) unconfirmed.push(slug);
    if (unconfirmed.length) throw new HttpError(502, "HERMES_PROFILE_CREATE_FAILED", "Le résultat de la création doit être vérifié.", {}, { unconfirmedProfiles: unconfirmed });
    if (isUniqueViolation(error)) throw new HttpError(409, "BOT_PROFILE_TAKEN", "Ce slug ou ce profil Hermes est déjà utilisé.");
    throw error;
  });
  if (provisionLater) return { ...bot, profileProvisionStatus: "preparing" as const };
  return profileModel ? { ...bot, profileModel } : bot;
  });
}

/**
 * Le `PATCH /api/bots/:botId`, partagé avec la Marketplace : les réglages d'un
 * modèle d'agent passent par la même lecture (`readEditorSettings`) et la
 * même écriture que l'éditeur. Le rôle est vérifié par l'appelant.
 */
export async function updateBot(
  db: Db,
  deps: BotDeps,
  organizationId: string,
  botId: string,
  input: UpdateBotInput,
): Promise<ReturnType<typeof publicBot> & { profileModel?: Awaited<ReturnType<typeof applyHostProfileModel>> }> {
  const { readRuntime, clientFactory } = deps;
  return withBotProfileLock(db, organizationId, botId, async (db) => {
  // Un changement de modèle écrit dans le profil hôte ; une restauration le
  // recrée, sauf si son nom appartient à un profil étranger.
  if (input.modelChanged) await assertBotProfileReady(db, organizationId, botId);
  let cleanupRestore: "none" | "queued-cancelled" | "running" = "none";
  if (input.restoring) {
    cleanupRestore = await lockBotHostCleanupForRestore(db, organizationId, botId);
    if (cleanupRestore === "running") throw new HttpError(409, "BOT_HOST_CLEANUP_RUNNING", "Son nettoyage sur votre serveur est en cours. Réessayez dans un instant.");
  }
  const restoreProvision = input.restoring ? await assertProvisionRestorable(db, organizationId, botId) : null;
  let restoreApprovalPolicy: Awaited<ReturnType<typeof ensureHostProfileForRestore>> = null;
  const currentRows = await withTenant(db, organizationId, (tx) => readBotRows(tx, organizationId, botId));
  const priorRows = input.editor.permissionMode !== undefined ? currentRows : [];
  const priorPermissionMode = priorRows[0]?.permissionMode;
  const permissionModeChanged = input.editor.permissionMode !== undefined && priorPermissionMode !== input.editor.permissionMode;
  if (permissionModeChanged && priorRows[0]) {
    await assertPermissionModeUnderCeiling(db, organizationId, input.editor.permissionMode!, priorPermissionMode ?? null);
  }
  const managedPermissionProfile = permissionModeChanged
    && priorRows[0]?.hermesProfileManaged === true
    && Boolean(priorRows[0].hermesProfile);
  const runtime = (input.modelChanged || input.restoring || managedPermissionProfile) ? await readRuntime(db, organizationId) : null;
  const pipeline = runtime ? await withTenant(db, organizationId, (tx) => readPermissionPipeline(tx, organizationId)) : "legacy";
  // PERM2-5: every host policy write carries the stored blocked keys.
  const blockedTools = runtime && (input.restoring || managedPermissionProfile) ? await withTenant(db, organizationId, (tx) => readBlockedToolsTx(tx, organizationId, botId)) : [];
  if (input.sectionId && !(await withTenant(db, organizationId, (tx) => sectionExists(tx, organizationId, input.sectionId!)))) {
    throw new HttpError(404, "SECTION_NOT_FOUND", "Section introuvable.");
  }
  let selection: Awaited<ReturnType<typeof resolvedHostProfileModel>> = null;
  if (input.modelChanged && runtime && currentRows[0]) {
    selection = await resolvedHostProfileModel(
      { model: input.model !== undefined ? input.model : currentRows[0].model, provider: input.provider },
      runtime,
      () => clientFactory(runtime.client).modelOptions(),
    );
  }
  if (input.archived === true) {
    await withTenant(db, organizationId, (tx) => assertBotQuiescent(
      tx,
      organizationId,
      botId,
      { code: "CANCELLED_BY_ARCHIVE", message: "Passe de maintenance annulée : le bot est archivé." },
      "Ce bot exécute encore une mission ou attend une réconciliation.",
    ));
  }
  const shouldApplyApprovalPolicy = Boolean(
    permissionModeChanged
    && priorRows[0]?.hermesProfileManaged === true
    && priorRows[0].hermesProfile
    && runtime?.linkFeatures?.includes(RELAY_FEATURE_APPROVAL_POLICY)
  );
  const nextPermissionMode = input.editor.permissionMode;
  const tightening = nextPermissionMode !== undefined && approvalPolicyWriteMustPrecedeCommit(nextPermissionMode);
  let approvalPolicyState: Awaited<ReturnType<typeof applyHostApprovalPolicy>> = null;
  if (shouldApplyApprovalPolicy && tightening) {
    await assertBotProfileReady(db, organizationId, botId);
  }
  if (input.restoring) {
    const current = await withTenant(db, organizationId, (tx) => readBotRestoreTarget(tx, organizationId, botId));
    if (!current) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
    const slug = namedHostProfileSlug(current.hermesProfile);
    if (slug && cleanupRestore !== "queued-cancelled" && restoreProvision?.mustBeAbsent && runtime) {
      let present: boolean;
      try { present = (await clientFactory(runtime.client).hostProfileInventory()).profiles.some((profile) => profile.name === slug); }
      catch { throw new HttpError(502, "HERMES_PROFILE_UNVERIFIED", "L’hôte n’a pas pu confirmer que ce nom de profil est libre. Réessayez."); }
      if (present) throw new HttpError(409, "PROFILE_SLUG_TAKEN", "Un profil Hermes porte déjà ce nom sur votre serveur : ce bot ne peut pas le reprendre.");
    }
    if (slug) {
      const restoreTarget = await withTenant(db, organizationId, (tx) => readBotRestoreTarget(tx, organizationId, botId));
      try {
        restoreApprovalPolicy = await ensureHostProfileForRestore(runtime, slug, current.name, clientFactory, restoreTarget?.permissionMode ?? "manual", pipeline, blockedTools);
      } catch (error) {
        if (runtime?.linkFeatures?.includes(RELAY_FEATURE_APPROVAL_POLICY)) {
          await withTenant(db, organizationId, (tx) => writeBotApprovalPolicyProof(tx, organizationId, botId, null, false));
        }
        throw error;
      }
    }
    if (restoreProvision?.cancelled) await closeProvisionAfterRestore(db, organizationId, botId);
  }
  let policyWriteUnproven = false;
  let rows: BotRow[];
  try {
    rows = await withTenant(db, organizationId, async (tx) => {
    if (input.archived === true) {
      const found = await assertBotQuiescent(
        tx,
        organizationId,
        botId,
        {
          code: "CANCELLED_BY_ARCHIVE",
          message: "Passe de maintenance annulée : le bot est archivé.",
        },
        "Ce bot exécute encore une mission ou attend une réconciliation.",
      );
      if (!found) return [] as BotRow[];
    }
    let nextPosition: number | null = null;
    if (input.sectionId) {
      if (!(await sectionExists(tx, organizationId, input.sectionId))) {
        throw new HttpError(404, "SECTION_NOT_FOUND", "Section introuvable.");
      }
      nextPosition = await nextBotPositionExcluding(tx, organizationId, input.sectionId, botId);
    }
    const mutateBot = async () => {
      if (!(await updateBotRow(tx, organizationId, botId, input, nextPosition))) return [] as BotRow[];
      if (restoreApprovalPolicy && !permissionModeChanged) {
        await writeBotApprovalPolicyProof(tx, organizationId, botId, restoreApprovalPolicy.mode, restoreApprovalPolicy.effective);
      }
      if (approvalPolicyState) await writeBotApprovalPolicyProof(tx, organizationId, botId, approvalPolicyState.mode, approvalPolicyState.effective);
      if (input.sectionId) await pruneEmptySections(tx, organizationId);
      return readBotRows(tx, organizationId, botId);
    };
    if (shouldApplyApprovalPolicy && tightening && runtime && priorRows[0]?.hermesProfile && nextPermissionMode) {
      try {
        return await applyTighteningPolicyBeforeMutation(nextPermissionMode, async () => {
          approvalPolicyState = await applyHostApprovalPolicy(runtime, priorRows[0]!.hermesProfile!, nextPermissionMode, pipeline, clientFactory, blockedTools);
        }, mutateBot);
      } catch (error) {
        policyWriteUnproven = true;
        if (error instanceof HermesClientError) throw new HttpError(error.status, error.code, error.message);
        throw error;
      }
    }
    return mutateBot();
    });
  } catch (error) {
    if (policyWriteUnproven) await withTenant(db, organizationId, (tx) => writeBotApprovalPolicyProof(tx, organizationId, botId, null, false));
    throw error;
  }
  if (!rows[0]) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
  if (shouldApplyApprovalPolicy && !tightening && runtime && priorRows[0]?.hermesProfile && nextPermissionMode) {
    try {
      approvalPolicyState = await applyHostApprovalPolicy(runtime, priorRows[0].hermesProfile, nextPermissionMode, pipeline, clientFactory, blockedTools);
      if (approvalPolicyState) await withTenant(db, organizationId, (tx) => writeBotApprovalPolicyProof(tx, organizationId, botId, approvalPolicyState!.mode, approvalPolicyState!.effective));
    } catch (error) {
      await withTenant(db, organizationId, (tx) => writeBotApprovalPolicyProof(tx, organizationId, botId, null, false));
      console.error(JSON.stringify({ event: "bot.approval_policy_reconcile_required", botId, organizationId, code: error instanceof HermesClientError ? error.code : "UNEXPECTED" }));
    }
  }
  const bot = publicBot(rows[0]);
  if (
    !input.modelChanged
    || rows[0].hermesProfileManaged !== true
    || !rows[0].hermesProfile
  ) {
    return bot;
  }
  if (!runtime?.linkFeatures?.includes(RELAY_FEATURE_PROFILE_CAPABILITIES)) {
    return bot;
  }
  // En mode global (choix global posé), le run envoie le modèle global et le
  // worker y ramène le profil (`resolveSelectionForNewRun`) : y écrire le
  // modèle propre du bot coûtait une écriture hôte, défaite au run suivant.
  if (runtime.selectedModel?.trim() && (await readModelAssignmentMode(db, organizationId)) === "global") {
    return bot;
  }
  const profileModel = await applyHostProfileModel(
    clientFactory(runtime.client),
    rows[0].hermesProfile,
    selection,
  );
  return { ...bot, profileModel };
  });
}

/**
 * Les conditions communes au soft delete et à la purge : inchangées depuis la
 * suppression en un temps, et rejouées à CHAQUE transaction de la purge :
 * entre la lecture des sessions et l'effacement de la ligne, il y a un aller
 * réseau vers le runtime, largement de quoi qu'un run démarre.
 *
 * Ne dit rien du bot inexistant : l'appelant le distingue par le nombre de
 * lignes que sa propre requête renvoie. `detachGroups` : la purge forcée détache
 * ses salons dans la même transaction ; leurs missions, lues avant, restent gardées.
 */
export async function assertBotDeletable(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  options: { detachGroups?: boolean } = {},
): Promise<void> {
  await assertBotProfileSettled(tx, organizationId, botId);
  await assertBotQuiescent(tx, organizationId, botId, {
    code: "CANCELLED_BY_DELETE",
    message: "Passe de maintenance annulée : le bot est supprimé.",
  }, "Ce bot exécute encore une mission. Arrêtez-la avant de supprimer le bot.", options.detachGroups === true);
}

/**
 * Un membre ne peut pas disparaître sous un salon : cela pourrait laisser un
 * groupe sous sa taille minimale et, surtout, un `default_responder` pilote
 * pointant vers un bot inactif. Le verrou fort du bot est déjà acquis par les
 * deux appelants. Les ajouts de membres prennent `FOR KEY SHARE` sur ce même
 * bot ; une création concurrente est donc soit visible ici, soit revalidée
 * après notre commit et refusée parce que le bot est désormais archivé.
 */
async function assertBotNotInGroup(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<void> {
  if (await isBotInGroup(tx, organizationId, botId)) {
    throw new HttpError(
      409,
      "BOT_IN_GROUP",
      "Retirez ce bot de ses salons ou choisissez un autre pilote avant de l’archiver ou de le supprimer.",
    );
  }
}

/**
 * Un run racine ou de salon en cours bloque l'archivage et la purge. Une passe
 * de maintenance (`memory`, `compaction`) est annulée, puis on continue.
 */
async function assertBotQuiescent(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  maintenanceReason: { code: string; message: string },
  busyMessage: string,
  allowGroups = false,
): Promise<boolean> {
  const active = await lockActiveBotRuns(tx, organizationId, botId);
  if (!(await lockBotRow(tx, organizationId, botId))) return false;
  await cancelMaintenanceRunsTx(
    tx,
    organizationId,
    active.filter((run) => isMaintenanceStepKind(run.stepKind)),
    maintenanceReason,
  );
  const blocking = active.find((run) => !isMaintenanceStepKind(run.stepKind))
    ?? (await readActiveBotRuns(tx, organizationId, botId))[0];
  if (blocking) {
    throw new HttpError(
      409,
      "BOT_BUSY",
      busyMessage,
      {},
      { runId: blocking.id, stepKind: blocking.stepKind ?? null },
    );
  }
  if (!allowGroups) await assertBotNotInGroup(tx, organizationId, botId);
  if (await hasPendingBotIngress(tx, organizationId, botId)) {
    throw new HttpError(409, "BOT_SUBMISSION_IN_PROGRESS", "Un message idempotent est encore en cours ou en quarantaine.");
  }
  return true;
}

/**
 * Supprimer un bot : en deux temps, parce que ses données ne sont pas
 * toutes chez nous.
 *
 * Sans `purge`, l'état du bot et le nettoyage durable de l'hôte sont écrits
 * ensemble. Le bot se restaure depuis Réglages → Archives.
 *
 * Avec `purge`, c'est la suppression définitive, et elle sort du SaaS :
 * Les sessions sont copiées dans la tâche de nettoyage avant que la ligne
 * ne soit purgée. `force` garde son sens historique : détacher des groupes.
 */
export async function deleteBot(
  db: Db,
  deps: BotDeps,
  organizationId: string,
  botId: string,
  options: { purge: boolean; force: boolean },
) {
  const { readRuntimeForDeletion } = deps;
  const { purge, force } = options;
  return withBotProfileLock(db, organizationId, botId, async (db) => {
    if (!purge) {
      const scope = await withTenant(db, organizationId, async (tx) => {
        await assertBotDeletable(tx, organizationId, botId);
        return readBotDeletionScope(tx, organizationId, botId);
      });
      if (!scope) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
      // Une création de profil encore en cours est annulée d'abord. Si le
      // profil de l'hôte n'est pas (encore) à ce bot, il n'est ni purgé ni
      // supprimé : il peut appartenir à quelqu'un d'autre sous ce nom.
      const { hostProfileOwned } = await cancelProfileProvision(db, organizationId, botId);

      const runtime = await readRuntimeForDeletion(db, organizationId);
      const slug = hostProfileOwned && scope.profileManaged ? namedHostProfileSlug(scope.profile) : null;
      const sessions = hostProfileOwned ? botRuntimeSessionIds(organizationId, botId, scope) : [];
      if (sessions.length && !runtime) {
        throw new HttpError(409, "RUNTIME_REQUIRED", "Enregistrez Hermes avant de supprimer un bot : ses sessions doivent partir du runtime.");
      }
      if (slug) {
        if (!runtime) {
          throw new HttpError(
            409,
            "RUNTIME_REQUIRED",
            "Enregistrez Hermes avant de supprimer un bot : son profil doit partir de l’hôte.",
          );
        }
        if (!runtime.linkFeatures?.includes(RELAY_FEATURE_PROFILE_MANAGEMENT)) {
          throw new HttpError(
            409,
            "PROFILE_MANAGEMENT_UNAVAILABLE",
            "L’hôte Hermes ne gère pas la suppression de profils.",
          );
        }
      }
      const rows = await withTenant(db, organizationId, async (tx) => {
        await assertBotDeletable(tx, organizationId, botId);
        const deletedAt = await softDeleteBot(tx, organizationId, botId);
        if (!deletedAt) return [] as BotRow[];
        if (runtime && (sessions.length > 0 || slug)) {
          await insertBotHostCleanup(tx, {
            organizationId, botId, botDeletedAt: deletedAt, runtimeId: runtime.id,
            profile: scope.profileManaged ? slug : null,
            sessionProfile: scope.profile,
            sessionIds: sessions,
          });
        }
        return readBotRows(tx, organizationId, botId);
      });
      if (!rows[0]) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
      return publicBot({ ...rows[0], hostCleanupStatus: runtime && (sessions.length > 0 || slug) ? "pending" : null });
    }

    // `force=1` sur une purge détache le bot de ses salons : mesuré au
    // navigateur le 04-09, le pilote d'un salon à deux membres était
    // inarchivable ET impurgeable (`BOT_IN_GROUP`), et le salon ne pouvait pas
    // perdre un membre sans passer sous `GROUP_MEMBERS_MIN`. La purge retire le
    // bot de chaque salon et supprime celui qui tomberait sous le minimum, dans
    // la transaction qui supprime le bot : un refus ne coûte aucun salon. La
    // corbeille, elle, reste refusée avec son message.
    // Les identifiants de session sont lus AVANT toute suppression, dans une
    // transaction qui a déjà verrouillé le bot : un fil créé après cette
    // lecture ne pourrait naître que d'un run, et un run actif a déjà fait
    // échouer `assertBotDeletable`.
    const scope = await withTenant(db, organizationId, async (tx) => {
      await assertBotDeletable(tx, organizationId, botId, { detachGroups: force });
      return readBotDeletionScope(tx, organizationId, botId);
    });
    if (!scope) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
    const { hostProfileOwned } = await cancelProfileProvision(db, organizationId, botId);
    const sessions = hostProfileOwned ? botRuntimeSessionIds(organizationId, botId, scope) : [];

    const runtime = await readRuntimeForDeletion(db, organizationId);
    const cleanupProfile = hostProfileOwned && scope.profileManaged ? namedHostProfileSlug(scope.profile) : null;
    if ((sessions.length > 0 || cleanupProfile) && !runtime) {
      throw new HttpError(409, "RUNTIME_REQUIRED", "Enregistrez Hermes avant de supprimer un bot : son nettoyage doit être enregistré sur le runtime.");
    }
    if (cleanupProfile && !runtime?.linkFeatures?.includes(RELAY_FEATURE_PROFILE_MANAGEMENT)) {
      throw new HttpError(409, "PROFILE_MANAGEMENT_UNAVAILABLE", "L’hôte Hermes ne gère pas la suppression de profils.");
    }
    const result = await withTenant(db, organizationId, async (tx) => {
      await assertBotDeletable(tx, organizationId, botId, { detachGroups: force });
      const groupsDetached = force ? await detachBotFromGroups(tx, organizationId, botId) : null;
      const existing = await tx<Array<{ status: string }>>`select status from bot_host_cleanups
        where organization_id = ${organizationId} and bot_id = ${botId}
          and bot_deleted_at = ${scope.deletedAt}
          and status in ('queued','running','failed','succeeded') limit 1`;
      let hostCleanup: "queued" | "none" = existing.length ? "none" : "queued";
      const needsCleanup = sessions.length > 0 || Boolean(cleanupProfile);
      if (!existing.length && runtime && needsCleanup) {
        await insertBotHostCleanup(tx, {
          organizationId, botId, botDeletedAt: scope.deletedAt ?? new Date(), runtimeId: runtime.id,
          profile: cleanupProfile,
          sessionProfile: scope.profile,
          sessionIds: hostProfileOwned ? sessions : [],
        });
      } else if (!runtime || !needsCleanup) {
        hostCleanup = "none";
      }
      const gone = await deleteBotRow(tx, organizationId, botId);
      if (gone) await pruneEmptySections(tx, organizationId);
      return { gone, hostCleanup, groupsDetached };
    });
    if (!result.gone) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
    return {
      id: botId,
      hostCleanup: result.hostCleanup,
      groupsDetached: result.groupsDetached,
    };
  });
}
