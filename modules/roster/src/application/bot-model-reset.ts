import type { BotModelResetDto, BotProfileModelSyncDto } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { applyHostProfileModel } from "./host-profile-model";
import { botsFollowingRuntimeModel, clearBotModelOverrides } from "../sql/bots";
import { resolvedHostProfileModel, type BotDeps, type BotRouteClient } from "./bot-host";
import { RELAY_FEATURE_PROFILE_CAPABILITIES, RELAY_FEATURE_PROFILE_MODEL_BATCH } from "@openedbot/contracts-connector/features";

/** Hôte sans `profile_model_batch` : un profil par appel, borné pour ne pas saturer le relais du lien. */
const ALIGN_CONCURRENCY = 4;
/**
 * Hôte avec `profile_model_batch` : un appel coûte une écriture et une relecture
 * d'inventaire quel que soit le nombre de profils (borne hôte : 64). 25 par lot
 * garde une progression lisible sur une grande flotte.
 */
const ALIGN_BATCH_SIZE = 25;

type SyncEntry = { sync: BotProfileModelSyncDto; finished: Promise<void> };

/** Le dernier alignement de chaque organisation, lu par la barre de progression. */
const syncs = new Map<string, SyncEntry>();

export function profileModelSync(organizationId: string): BotProfileModelSyncDto | null {
  const entry = syncs.get(organizationId);
  return entry ? { ...entry.sync } : null;
}

export type AlignCandidate = { botId: string; profile: string };
type AlignOutcome = "aligned" | "failed" | "skipped";
export type ProfileModelSyncClient = Pick<BotRouteClient, "modelOptions" | "hostProfileInventory" | "hostSetProfileModel" | "hostSetProfileModels">;
export type ProfileModelSyncDeps = {
  client: ProfileModelSyncClient;
  /** La sélection du runtime que les profils doivent porter. */
  runtime: { selectedProvider?: string | null; selectedModel?: string | null };
  /** L'hôte annonce `profile_model_batch`. */
  batch: boolean;
  /** Parmi ces bots, ceux qui suivent encore le modèle du runtime (ni supprimés, ni dotés d'un modèle propre). */
  stillFollowing: (botIds: string[]) => Promise<Set<string>>;
};

/** `stillFollowing` lu en base : le mode de l'organisation compte, comme au run. */
export function followingInDb(db: Db, organizationId: string): ProfileModelSyncDeps["stillFollowing"] {
  return async (botIds) => new Set(await withTenant(db, organizationId, (tx) => botsFollowingRuntimeModel(tx, organizationId, botIds)));
}

/**
 * Lance en arrière-plan l'alignement du bloc `model` de ces profils sur la
 * sélection du runtime, et rend son état initial. Un alignement déjà en cours
 * pour l'organisation n'est pas interrompu : le nouveau l'attend, puis écrit
 * sa propre cible. Le dernier écrit est donc toujours le dernier choix.
 *
 * Rien ici n'est requis pour la justesse : le worker relit le bloc du profil à
 * chaque run et le réécrit s'il diffère (`resolveSelectionForNewRun`). Aligner
 * d'avance épargne cette écriture au premier run de chaque bot.
 */
export function startProfileModelSync(
  organizationId: string,
  candidates: AlignCandidate[],
  deps: ProfileModelSyncDeps,
  source?: "global_selection",
): BotProfileModelSyncDto {
  const previous = syncs.get(organizationId)?.finished;
  const sync: BotProfileModelSyncDto = {
    id: crypto.randomUUID(),
    status: "running",
    total: candidates.length,
    done: 0,
    aligned: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const started = performance.now();
  const finished = (async () => {
    await previous;
    await alignProfileModels(sync, candidates, deps);
  })().finally(() => {
    console.log(JSON.stringify({
      event: "bot.model_reset_synced",
      organizationId,
      ...(source ? { source } : {}),
      batch: deps.batch,
      total: sync.total,
      aligned: sync.aligned,
      failed: sync.failed,
      ms: Math.round(performance.now() - started),
    }));
  });
  syncs.set(organizationId, { sync, finished });
  return { ...sync };
}

/**
 * « Repasser tous les bots au modèle global ».
 *
 * La remise à zéro est une seule écriture en base, faite avant la réponse :
 * c'est elle qui décide du modèle des prochains runs. Le bloc `model` des
 * profils hôte s'aligne ensuite en arrière-plan. Le PATCH bot par bot payait
 * cette écriture hôte (≈ 2 s mesurées sur le lab, `make e2e-bot
 * SCENARIOS=model-reset`) en série, sur le chemin de la requête.
 */
export async function resetBotModelOverrides(db: Db, deps: BotDeps, organizationId: string): Promise<BotModelResetDto> {
  const cleared = await withTenant(db, organizationId, (tx) => clearBotModelOverrides(tx, organizationId));
  const candidates = cleared.flatMap((row) =>
    row.profileManaged && row.profile && row.profileReady ? [{ botId: row.botId, profile: row.profile }] : []);
  const current = profileModelSync(organizationId);
  const unchanged = { cleared: cleared.length, sync: current?.status === "running" ? current : null };
  if (candidates.length === 0) return unchanged;
  const runtime = await deps.readRuntime(db, organizationId);
  if (!runtime?.linkFeatures?.includes(RELAY_FEATURE_PROFILE_CAPABILITIES)) return unchanged;
  const sync = startProfileModelSync(organizationId, candidates, {
    client: deps.clientFactory(runtime.client),
    runtime,
    batch: runtime.linkFeatures.includes(RELAY_FEATURE_PROFILE_MODEL_BATCH),
    stillFollowing: followingInDb(db, organizationId),
  });
  return { cleared: cleared.length, sync };
}

/**
 * Écrit la sélection du runtime dans chaque profil qui ne la porte pas déjà,
 * et tient `sync` à jour au fil des écritures. Un seul catalogue et un seul
 * inventaire pour toute la flotte ; un profil déjà juste ne coûte aucune
 * écriture. Ne lève jamais : un échec compte dans `failed`.
 */
export async function alignProfileModels(
  sync: BotProfileModelSyncDto,
  candidates: AlignCandidate[],
  deps: ProfileModelSyncDeps,
): Promise<void> {
  const count = (outcome: AlignOutcome) => {
    if (outcome === "aligned") sync.aligned += 1;
    if (outcome === "failed") sync.failed += 1;
    sync.done += 1;
  };
  try {
    const selection = await resolvedHostProfileModel({}, deps.runtime, () => deps.client.modelOptions());
    // Pas de sélection au runtime : il n'y a rien à poser dans les profils.
    if (!selection) {
      candidates.forEach(() => count("skipped"));
      return;
    }
    const inventory = await deps.client.hostProfileInventory().catch(() => null);
    const current = new Map(inventory?.profiles.map((profile) => [profile.name, profile.model]) ?? []);
    const queue = candidates.filter((candidate) => {
      const model = current.get(candidate.profile);
      const alreadyAligned = model?.provider === selection.provider && model.default === selection.model;
      if (alreadyAligned) count("aligned");
      return !alreadyAligned;
    });
    if (deps.batch) {
      for (let start = 0; start < queue.length; start += ALIGN_BATCH_SIZE) {
        const chunk = queue.slice(start, start + ALIGN_BATCH_SIZE);
        const following = await deps.stillFollowing(chunk.map((candidate) => candidate.botId));
        const live = chunk.filter((candidate) => following.has(candidate.botId));
        chunk.filter((candidate) => !following.has(candidate.botId)).forEach(() => count("skipped"));
        if (live.length === 0) continue;
        const applied = await deps.client.hostSetProfileModels(live.map((candidate) => candidate.profile), selection)
          .then((entries) => new Map(entries.map((entry) => [entry.profile, entry.applied])))
          .catch(() => new Map<string, boolean>());
        live.forEach((candidate) => count(applied.get(candidate.profile) ? "aligned" : "failed"));
      }
      return;
    }
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const candidate = queue[next++]!;
        const following = await deps.stillFollowing([candidate.botId]).catch(() => new Set<string>([candidate.botId]));
        if (!following.has(candidate.botId)) {
          count("skipped");
          continue;
        }
        count((await applyHostProfileModel(deps.client, candidate.profile, selection)).applied ? "aligned" : "failed");
      }
    };
    await Promise.all(Array.from({ length: Math.min(ALIGN_CONCURRENCY, queue.length) }, worker));
  } catch {
    // Catalogue illisible ou sélection retirée du catalogue : le reste est en échec.
    sync.failed += sync.total - sync.done;
    sync.done = sync.total;
  } finally {
    sync.status = "done";
    sync.finishedAt = new Date().toISOString();
  }
}
