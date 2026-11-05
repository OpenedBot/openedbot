import type { SQL } from "bun";
import { HermesClientError, type HermesClient } from "@openedbot/hermes";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { applyHostApprovalPolicyWithClient } from "./approval-policy";
import { permissionPipelineOf } from "@openedbot/runtimes/domain/runtime-contract";
import { publicBot } from "../domain/bot-dto";
import { readBotRows, writeBotApprovalPolicyProof } from "../sql/bots";
import { readBlockedToolsTx } from "../sql/tool-policies";
import type { ProfileProvisionRow } from "../sql/profile-provisions";
import { BASELINE_REQUIRED_FEATURES } from "../domain/capability-baseline";
import type { BotProfileProvisionProgress } from "@openedbot/contracts-api";

/**
 * Plus long que tout ce qu'un passage fait sous un même bail : la création
 * (`PROFILE_MUTATION_TIMEOUT_MS`, 120 s) puis la relecture de l'inventaire.
 * Le bail ne peut donc pas expirer pendant un appel en cours : une
 * suppression (409 tant qu'il vit) ne croise jamais une création qui aboutit.
 */
export const PROFILE_PROVISION_LEASE_SECONDS = 240;
export type ProfileProvisionClient = Pick<HermesClient, "hostCreateProfile" | "hostProfileInventory" | "hostDeleteProfile" | "hostCapabilities" | "hostSetApprovalPolicy" | "hostApprovalPolicy" | "probeProfileIsolation">;
export type ProfileProvisionDependencies = {
  client(runtimeId: string): ProfileProvisionClient;
  signal?: AbortSignal;
  /** How long the gateway may take to serve a new profile (tests shorten it). */
  serveWait?: { timeoutMs: number; pollMs: number; sleep(ms: number): Promise<unknown> };
  /**
   * The capability baseline of the served profile, applied before success.
   * Without it the worker's reconciliation turned tools on seconds after the
   * first turns: each change of the tool list missed the prompt cache.
   * Best effort: a failure leaves the version, and the reconciliation retries.
   * `timings` is this pass's record: the baseline may add its own steps.
   * `bundledSkillsOff`: the host proved, at creation, the bundled skills off.
   * `onTools`: the toolsets it is about to enable, for the console (0164).
   */
  baseline?(job: ProfileProvisionRow, timings: Record<string, number>, created: {
    bundledSkillsOff: boolean;
    onTools(names: readonly string[]): Promise<void>;
  }): Promise<string>;
};

export type ProfileProvisionStep = BotProfileProvisionProgress["step"];

/**
 * The inventory lists a new profile as soon as its directory exists, but the
 * multiplexed gateway serves `/p/<slug>/` only after its served-profile
 * reconcile (immediate on `hermes profile create`, about 3 s on the lab;
 * every 30 s as a safety net). A run claimed in that gap gets a 404 and fails
 * as HERMES_PROFILE_MISSING (the greeting, held until the provision
 * succeeds, is claimed about a second later and would land right there).
 */
export const PROFILE_SERVE_WAIT = { timeoutMs: 45_000, pollMs: 500, sleep: (ms: number) => Bun.sleep(ms) };

/**
 * Un bot dont le profil se prépare (en file ou en cours) ne se supprime pas :
 * refus net, avant tout effet. Attendre la fin de la passe faisait patienter
 * la demande jusqu'à 20 s, puis supprimait un bot que l'écran montrait
 * encore en train d'arriver. Un profil en échec, lui, se supprime.
 */
export async function assertBotProfileSettled(tx: TransactionDb, organizationId: string, botId: string): Promise<void> {
  const rows = await tx<Array<{ status: string }>>`
    select status from bot_profile_provisions
     where organization_id = ${organizationId} and bot_id = ${botId} and status in ('queued', 'running')
  `;
  if (rows.length) {
    throw new HttpError(409, "BOT_PROFILE_PREPARING", "Ce bot se prépare encore sur votre serveur. Vous pourrez le supprimer dès qu’il sera prêt.");
  }
}

/**
 * Les écritures sur le profil hôte d'un bot (toolsets, MCP, skills, modèle,
 * identifiants, réparation) attendent que ce profil existe : tant que sa
 * création est en file ou a échoué, l'hôte n'a rien à modifier.
 */
export async function assertBotProfileReady(db: Db, organizationId: string, botId: string): Promise<void> {
  const rows = await withTenant(db, organizationId, (tx) => tx<Array<{ status: string }>>`
    select status from bot_profile_provisions where organization_id = ${organizationId} and bot_id = ${botId}
  `);
  const status = rows[0]?.status;
  if (!status || status === "succeeded") return;
  throw status === "failed"
    ? new HttpError(409, "BOT_PROFILE_PROVISION_FAILED", "Le profil de ce bot n’a pas pu être créé sur votre serveur. Relancez sa création.")
    : new HttpError(409, "BOT_PROFILE_PREPARING", "Le profil de ce bot se prépare encore sur votre serveur. Réessayez dans quelques secondes.");
}

export async function retryBotProfileProvision(db: Db, organizationId: string, botId: string) {
  return withTenant(db, organizationId, async (tx) => {
    const changed = await tx<Array<{ bot_id: string }>>`
      update bot_profile_provisions
         set status = 'queued', attempts = 0, next_attempt_at = now(), error = null,
             finished_at = null, lease_owner = null, lease_expires_at = null, updated_at = now()
       where organization_id = ${organizationId} and bot_id = ${botId} and status = 'failed'
         and host_profile_ownership <> 'foreign'
       returning bot_id
    `;
    if (!changed.length) {
      const exists = await tx<Array<{ status: string; ownership: string }>>`
        select status, host_profile_ownership as ownership from bot_profile_provisions where organization_id = ${organizationId} and bot_id = ${botId}
      `;
      if (!exists.length) throw new HttpError(404, "BOT_PROFILE_PROVISION_NOT_FOUND", "Provision du profil introuvable.");
      // Un nom pris par un profil étranger ne se relance pas : le reprendre
      // rattacherait ce bot à la mémoire d'un autre.
      if (exists[0]!.ownership === "foreign") {
        throw new HttpError(409, "PROFILE_SLUG_TAKEN", "Un profil Hermes porte déjà ce nom sur votre serveur : ce bot ne peut pas le reprendre.");
      }
      throw new HttpError(409, "PROFILE_PROVISION_NOT_FAILED", "La création du profil n’est pas en échec.");
    }
    const rows = await readBotRows(tx, organizationId, botId);
    if (!rows[0]) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
    return publicBot({ ...rows[0], profileProvisionStatus: "preparing" });
  });
}

export async function claimProfileProvision(db: SQL, workerId: string): Promise<ProfileProvisionRow | null> {
  const rows = await db<ProfileProvisionRow[]>`
    with candidate as (
      select bot_id from bot_profile_provisions
       where ((status = 'queued' and next_attempt_at <= now())
          or (status = 'running' and lease_expires_at < now()))
         and not exists (
           select 1 from bot_host_cleanups cleanup
            where cleanup.runtime_id = bot_profile_provisions.runtime_id
              and cleanup.profile = bot_profile_provisions.slug
              and cleanup.status in ('queued','running')
              -- A cleanup that already proved the profile gone only re-reads
              -- sessions now, never this name (0150): no reason to wait.
              and cleanup.profile_removed_at is null
         )
       order by next_attempt_at, bot_id for update skip locked limit 1
    )
    update bot_profile_provisions p set status = 'running', lease_owner = ${workerId},
      lease_generation = p.lease_generation + 1,
      lease_expires_at = now() + (${PROFILE_PROVISION_LEASE_SECONDS} * interval '1 second'),
      updated_at = now()
    from candidate where p.bot_id = candidate.bot_id returning p.*
  `;
  return rows[0] ?? null;
}

/**
 * Un passage sur une demande réclamée. Quatre règles, issues de la revue :
 * 1. un profil déjà présent sous ce nom avant tout appel de création n'est
 *    jamais adopté (`PROFILE_SLUG_TAKEN`) ; un inventaire illisible ne vaut
 *    pas absence : on réessaie plus tard, sans rien créer ;
 * 2. `PROFILE_EXISTS` au tout premier appel veut dire qu'un autre l'a créé
 *    entre-temps : même refus. Après une interruption (`host_create_attempted`
 *    déjà vrai), il peut être le nôtre : la relecture tranche ;
 * 3. avant chaque effet sur l'hôte, le bail est revérifié et prolongé : un
 *    worker dont le bail a expiré n'écrit plus rien ;
 * 4. si la demande a disparu (bot supprimé ou mis à la corbeille, qui
 *    l'annule), le profil que ce passage a créé est retiré de l'hôte.
 */
export async function executeProfileProvision(db: SQL, job: ProfileProvisionRow, deps: ProfileProvisionDependencies): Promise<void> {
  if (deps.signal?.aborted) return;
  const client = deps.client(job.runtime_id);
  // Durations of this pass, saved with the update that closes it (0151).
  // Names and milliseconds only.
  const passStartedAt = Date.now();
  const timings: Record<string, number> = {};
  if (job.created_at && job.updated_at) timings.claimedAfterMs = Math.max(0, job.updated_at.getTime() - job.created_at.getTime());
  const holdLease = async (extra: { markAttempted: boolean }): Promise<boolean> => {
    const rows = await db<Array<{ bot_id: string }>>`
      update bot_profile_provisions
         set lease_expires_at = now() + (${PROFILE_PROVISION_LEASE_SECONDS} * interval '1 second'),
             host_create_attempted = host_create_attempted or ${extra.markAttempted},
             updated_at = now()
       where bot_id = ${job.bot_id} and status = 'running' and lease_owner = ${job.lease_owner}
         and lease_generation = ${job.lease_generation} and lease_expires_at > now()
       returning bot_id
    `;
    return rows.length > 0;
  };
  const finish = async (outcome: "succeeded" | "retry" | "failed", error: { code: string; message: string } | null, resetAttempted = false) => {
    const failedNow = outcome === "failed" || (outcome === "retry" && job.attempts + 1 >= 3);
    const status = outcome === "succeeded" ? "succeeded" : failedNow ? "failed" : "queued";
    const finalError = outcome === "succeeded" ? null : failedNow ? (error ?? PROVISION_FAILED) : null;
    const rows = await db<Array<{ bot_id: string }>>`
      update bot_profile_provisions
         set status = ${status},
             attempts = case when ${outcome === "succeeded"} then attempts else attempts + 1 end,
             next_attempt_at = case when ${status === "queued"} then now() + ((attempts + 1) * interval '5 seconds') else next_attempt_at end,
             error = ${finalError}::jsonb,
             host_create_attempted = host_create_attempted and not ${resetAttempted},
             host_profile_ownership = case
               when ${outcome === "succeeded"} then 'ours'
               when ${finalError?.code === "PROFILE_SLUG_TAKEN"} then 'foreign'
               else host_profile_ownership end,
             finished_at = case when ${status === "queued"} then null else now() end,
             timings = ${{ ...timings, totalMs: Date.now() - passStartedAt, attempt: job.attempts + 1 }}::jsonb,
             lease_owner = null, lease_expires_at = null, updated_at = now()
       where bot_id = ${job.bot_id} and status = 'running' and lease_owner = ${job.lease_owner}
         and lease_generation = ${job.lease_generation} and lease_expires_at > now()
       returning bot_id
    `;
    if (rows.length) {
      const event = outcome === "succeeded" ? "succeeded" : status === "failed" ? (finalError?.code === "PROFILE_SLUG_TAKEN" ? "slug_taken" : "failed") : "retry";
      console.info(JSON.stringify({ event: `profile_provision.${event}`, botId: job.bot_id, organizationId: job.organization_id, generation: job.lease_generation, attempt: job.attempts + (outcome === "succeeded" ? 0 : 1) }));
    }
    return rows.length > 0;
  };
  /**
   * The step the console shows on the bot's waiting screen (0164). Best
   * effort, under this pass's lease: a failed write costs a log line, never
   * the profile, and a lost lease writes nothing.
   */
  const progress = async (step: ProfileProvisionStep, tools?: readonly string[]): Promise<void> => {
    const value: BotProfileProvisionProgress = tools ? { step, tools: [...tools] } : { step };
    try {
      await db`
        update bot_profile_provisions set progress = ${value}::jsonb
         where bot_id = ${job.bot_id} and status = 'running' and lease_owner = ${job.lease_owner}
           and lease_generation = ${job.lease_generation}
      `;
    } catch {
      console.info(JSON.stringify({ event: "profile_provision.progress_unwritten", botId: job.bot_id, organizationId: job.organization_id, step }));
    }
  };
  const listed = async (): Promise<boolean | null> => {
    try { return (await client.hostProfileInventory()).profiles.some((profile) => profile.name === job.slug); }
    catch (error) {
      // Le code seul, jamais le message de l'hôte : sans cette ligne, trois
      // essais échouaient sans laisser de trace de leur motif.
      console.info(JSON.stringify({ event: "profile_provision.inventory_unreadable", botId: job.bot_id, organizationId: job.organization_id, code: error instanceof HermesClientError ? error.code : "UNEXPECTED" }));
      return null;
    }
  };

  /** The profile's isolation once the gateway serves it, or `null` when it does not (yet). */
  const servedByGateway = async (): Promise<"isolated" | "not_partitioned" | null> => {
    const wait = deps.serveWait ?? PROFILE_SERVE_WAIT;
    if (!(await holdLease({ markAttempted: false }))) return null;
    const deadline = Date.now() + wait.timeoutMs;
    for (;;) {
      // `not_partitioned` serves every prefix: nothing to wait for. A probe
      // error is not proof either way: keep asking until the deadline.
      const isolation = await client.probeProfileIsolation(job.slug).catch(() => "unreadable" as const);
      if (isolation === "isolated" || isolation === "not_partitioned") return isolation;
      if (Date.now() >= deadline || deps.signal?.aborted) return null;
      await wait.sleep(wait.pollMs);
    }
  };

  const resumed = job.host_create_attempted;
  const startedAt = Date.now();
  await progress("space");
  // The host's features do not depend on the profile: read them while the
  // profile is created (~1 s saved, VM 240). The outcome is held, never
  // thrown here: a failure is the approval step's, as when it read them.
  const hostFeatures = client.hostCapabilities().then(
    (features) => ({ features, error: null }),
    (error: unknown) => ({ features: null, error }),
  );
  if (!resumed) {
    const present = await listed();
    if (present === null) { await finish("retry", null); return; }
    if (present) { await finish("failed", SLUG_TAKEN); return; }
  }
  // Noté et bail prolongé AVANT l'appel : s'il aboutit puis que le worker
  // tombe, l'essai suivant sait que le profil trouvé peut être le sien.
  if (!(await holdLease({ markAttempted: true }))) return;

  // A new bot's baseline turns the bundled skills off: when it will run, the
  // creation does it in the same host process (one interpreter less). A host
  // that ignores the field answers without proof, and the baseline writes.
  const { features: knownFeatures } = await hostFeatures;
  const bundledAtCreation = Boolean(deps.baseline) && BASELINE_REQUIRED_FEATURES.every((name) => knownFeatures?.includes(name));
  const createStartedAt = Date.now();
  let created = false;
  let readBackByHost = false;
  let bundledSkillsOff = false;
  try {
    const result = await client.hostCreateProfile(job.slug, {
      displayName: job.display_name,
      ...(job.provider && job.model ? { provider: job.provider, model: job.model } : {}),
      ...(bundledAtCreation ? { bundledSkills: false as const } : {}),
    });
    created = true;
    bundledSkillsOff = bundledAtCreation && result?.bundledSkills?.applied === true && result.bundledSkills.profile === job.slug;
    // The host re-read the profile it wrote (listed under this name, requested
    // model present): the same proof as the inventory, one probe cheaper. A
    // host that does not say so (older edge-setup) is proven below as before.
    readBackByHost = result?.readBack === "profile" && result.name === job.slug;
  } catch (error) {
    // Un refus net de l'hôte (4xx) dit que cet appel n'a rien créé : la
    // présomption « le profil trouvé peut être le nôtre » retombe. Seul un
    // résultat incertain (délai, 5xx, réseau) la garde.
    const refused = error instanceof HermesClientError && error.status >= 400 && error.status < 500;
    if (error instanceof HermesClientError) {
      console.info(JSON.stringify({ event: "profile_provision.create_refused", botId: job.bot_id, organizationId: job.organization_id, status: error.status, code: error.code }));
    }
    // Le nom ou le corps refusés par l'hôte ne changeront pas d'un essai à
    // l'autre : réessayer ne ferait que retarder l'échec (un nom réservé en
    // amont, par exemple, voir `HERMES_RESERVED_PROFILE_NAMES`).
    if (refused && (error.code === "PROFILE_INVALID" || error.code === "BODY_INVALID")) {
      await finish("failed", NAME_REFUSED, true);
      return;
    }
    if (refused && error.code === "PROFILE_EXISTS" && !resumed) {
      await finish("failed", SLUG_TAKEN, true);
      return;
    }
    // En reprise, `PROFILE_EXISTS` signale le plus souvent notre propre appel
    // précédent : la relecture ci-dessous tranche. Tout autre refus réessaie.
    if (refused && !(resumed && error.code === "PROFILE_EXISTS")) {
      await finish("retry", null, !resumed);
      return;
    }
  }

  const createdAt = Date.now();
  const proven = readBackByHost || (await listed()) === true;
  // Durations of the steps that sit on the clone path: compare
  // `proof: "inventory"` with `proof: "create"` to measure the saved read.
  console.info(JSON.stringify({
    event: "profile_provision.timings", botId: job.bot_id, organizationId: job.organization_id,
    precheckMs: createStartedAt - startedAt, createMs: createdAt - createStartedAt, proofMs: Date.now() - createdAt,
    proof: readBackByHost ? "create" : "inventory",
  }));
  timings.precheckMs = createStartedAt - startedAt;
  timings.createMs = createdAt - createStartedAt;
  timings.proofMs = Date.now() - createdAt;
  const approvalStartedAt = Date.now();
  if (proven) {
    await progress("rules");
    try {
      const botRows = await withTenant(db as unknown as Db, job.organization_id, (tx) => tx<Array<{ permission_mode: "manual" | "plan" | "auto" | "bypass"; permission_pipeline: string }>>`
        select b.permission_mode, o.permission_pipeline
          from bots b join organizations o on o.id = b.organization_id
         where b.organization_id = ${job.organization_id} and b.id = ${job.bot_id}
      `);
      const bot = botRows[0];
      if (!bot) throw new Error("profile owner is unavailable");
      const { features, error: featuresError } = await hostFeatures;
      if (featuresError) throw featuresError;
      if (features?.includes("approval_policy")) {
        const blocked = await withTenant(db as unknown as Db, job.organization_id, (tx) => readBlockedToolsTx(tx, job.organization_id, job.bot_id));
        const policy = await applyHostApprovalPolicyWithClient(client, job.slug, bot.permission_mode, permissionPipelineOf(bot.permission_pipeline), blocked);
        await withTenant(db as unknown as Db, job.organization_id, (tx) => writeBotApprovalPolicyProof(tx, job.organization_id, job.bot_id, policy.mode, policy.effective));
      }
    } catch (error) {
      await withTenant(db as unknown as Db, job.organization_id, (tx) => writeBotApprovalPolicyProof(tx, job.organization_id, job.bot_id, null, false));
      console.info(JSON.stringify({ event: "profile_provision.approval_policy_unverified", botId: job.bot_id, organizationId: job.organization_id, code: error instanceof HermesClientError ? error.code : "UNEXPECTED" }));
      await finish("retry", null);
      return;
    }
  }
  // Success means a run can use the profile: the gateway serves it. A lost
  // lease falls through to the orphan cleanup below, like a lost finish.
  if (proven) timings.approvalMs = Date.now() - approvalStartedAt;
  const serveStartedAt = Date.now();
  const usable = proven && (await servedByGateway()) !== null;
  if (proven) timings.serveMs = Date.now() - serveStartedAt;
  if (proven && !usable) console.info(JSON.stringify({ event: "profile_provision.not_served", botId: job.bot_id, organizationId: job.organization_id }));
  if (usable && deps.baseline && (await holdLease({ markAttempted: false }))) {
    const baselineStartedAt = Date.now();
    try {
      await progress("tools");
      const outcome = await deps.baseline(job, timings, { bundledSkillsOff, onTools: (names) => progress("tools", names) });
      if (outcome !== "applied") console.info(JSON.stringify({ event: "profile_provision.baseline_deferred", botId: job.bot_id, organizationId: job.organization_id, outcome }));
    } catch (error) {
      console.info(JSON.stringify({ event: "profile_provision.baseline_deferred", botId: job.bot_id, organizationId: job.organization_id, outcome: "failed", code: error instanceof HermesClientError ? error.code : "UNEXPECTED" }));
    }
    timings.baselineMs = Date.now() - baselineStartedAt;
  }
  const done = await finish(usable ? "succeeded" : "retry", null);
  if (done) return;
  // Bail perdu pendant l'appel. Une suppression attend la fin d'un passage en
  // cours (409) : la ligne ne peut avoir disparu que par une purge forcée
  // après expiration du bail. Ce passage retire alors ce qu'il a créé.
  const current = await db<Array<{ bot_id: string }>>`select bot_id from bot_profile_provisions where bot_id = ${job.bot_id}`;
  if (current.length || !created) return;
  try { await client.hostDeleteProfile(job.slug); } catch {}
  console.info(JSON.stringify({ event: "profile_provision.orphan_cleanup", botId: job.bot_id, organizationId: job.organization_id }));
}

const PROVISION_FAILED = { code: "PROFILE_PROVISION_FAILED", message: "Son profil n’a pas pu être créé sur votre serveur." } as const;
const NAME_REFUSED = { code: "PROFILE_NAME_REFUSED", message: "Votre serveur refuse ce nom de profil. Créez le bot sous un autre nom." } as const;
const SLUG_TAKEN = { code: "PROFILE_SLUG_TAKEN", message: "Un profil Hermes porte déjà ce nom sur votre serveur. Renommez le bot, puis relancez sa création." } as const;

/**
 * Annule la demande de profil d'un bot qu'on met à la corbeille ou purge, et
 * dit si le profil de l'hôte est le sien. La ligne reste (`cancelled`) : la
 * purge qui suit la corbeille relit la même réponse. Pendant qu'un worker
 * parle à l'hôte (bail vivant), la suppression attend : 409, sans effet.
 * Propriétaire : réussi, ou un appel de création est parti après une
 * vérification d'absence et rien n'a désigné un profil étranger. Sans ligne :
 * bot d'avant ce mécanisme ou créé en synchrone, le profil est le sien.
 */
export async function cancelProfileProvision(
  db: Db,
  organizationId: string,
  botId: string,
  wait: { timeoutMs: number; pollMs: number; sleep(ms: number): Promise<unknown> } = PROVISION_SETTLE_WAIT,
): Promise<{ hostProfileOwned: boolean }> {
  // The bot's page opens while its profile is still being created, so an
  // operator can delete a bot while a worker is creating its profile. That
  // creation decides who owns the host profile: wait for it to settle (a few
  // seconds), then decide on the settled row, rather than refusing at once.
  const deadline = Date.now() + wait.timeoutMs;
  let row = await lockAndCancelProvision(db, organizationId, botId);
  while (row?.live && Date.now() < deadline) {
    await wait.sleep(wait.pollMs);
    row = await lockAndCancelProvision(db, organizationId, botId);
  }
  if (!row) return { hostProfileOwned: true };
  if (row.live) {
    throw new HttpError(409, "BOT_PROFILE_PREPARING", "Le profil de ce bot se crée en ce moment sur votre serveur. Réessayez dans quelques secondes.");
  }
  if (row.status === "succeeded" || row.ownership === "ours") return { hostProfileOwned: true };
  return { hostProfileOwned: row.attempted && row.ownership !== "foreign" };
}

const PROVISION_SETTLE_WAIT = { timeoutMs: 20_000, pollMs: 250, sleep: (ms: number) => Bun.sleep(ms) };

async function lockAndCancelProvision(db: Db, organizationId: string, botId: string) {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx<Array<{ status: string; live: boolean; attempted: boolean; ownership: string }>>`
      select status, (status = 'running' and lease_expires_at > now()) as live,
             host_create_attempted as attempted, host_profile_ownership as ownership
        from bot_profile_provisions
       where organization_id = ${organizationId} and bot_id = ${botId}
       for update
    `;
    const current = rows[0];
    if (!current || current.live || current.status === "succeeded" || current.status === "cancelled") return current ?? null;
    await tx`
      update bot_profile_provisions
         set status = 'cancelled', lease_owner = null, lease_expires_at = null, finished_at = now(), updated_at = now()
       where organization_id = ${organizationId} and bot_id = ${botId}
    `;
    return current;
  });
}

/**
 * Restauration depuis la corbeille d'un bot dont la demande a été annulée :
 * un nom pris par un profil étranger n'est jamais adopté (409) ; sinon le
 * profil est recréé par la restauration, puis la demande est close.
 */
export async function assertProvisionRestorable(db: Db, organizationId: string, botId: string): Promise<{ cancelled: boolean; mustBeAbsent: boolean }> {
  const rows = await withTenant(db, organizationId, (tx) => tx<Array<{ status: string; ownership: string; attempted: boolean }>>`
    select status, host_profile_ownership as ownership, host_create_attempted as attempted from bot_profile_provisions
     where organization_id = ${organizationId} and bot_id = ${botId}
  `);
  const row = rows[0];
  if (!row || row.status === "succeeded") return { cancelled: false, mustBeAbsent: false };
  if (row.status !== "cancelled") await assertBotProfileReady(db, organizationId, botId);
  if (row.ownership === "foreign") {
    throw new HttpError(409, "PROFILE_SLUG_TAKEN", "Un profil Hermes porte déjà ce nom sur votre serveur : ce bot ne peut pas le reprendre.");
  }
  // Jamais créé par openedbot : un profil trouvé sous ce nom serait étranger.
  // L'appelant vérifie l'hôte avant de laisser la restauration le recréer.
  return { cancelled: true, mustBeAbsent: row.ownership !== "ours" && !row.attempted };
}

export async function closeProvisionAfterRestore(db: Db, organizationId: string, botId: string): Promise<void> {
  await withTenant(db, organizationId, (tx) => tx`
    update bot_profile_provisions
       set status = 'succeeded', host_profile_ownership = 'ours', error = null, finished_at = now(), updated_at = now()
     where organization_id = ${organizationId} and bot_id = ${botId} and status = 'cancelled'
  `);
}
