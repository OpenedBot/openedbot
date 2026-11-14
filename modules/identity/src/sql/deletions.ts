import type { Db, TransactionDb } from "@openedbot/platform-db";

/** Ce que l'écran de suppression de compte lit d'une demande de purge. */
export type TenantDeletionRow = {
  reason: string;
  requestedAt: Date | string;
  purgeAfter: Date | string | null;
  startedAt: Date | string | null;
  leaseExpiresAt: Date | string | null;
};

/**
 * Une transaction sous le tenant ET sous l'utilisateur qui s'authentifie :
 * `memberships` a une seconde policy pour les lectures par utilisateur, et la
 * détection de comptes multi-organisations doit rester sous RLS.
 */
export async function withAccountTenant<T>(
  db: Db,
  scope: { organizationId: string; userId: string },
  callback: (tx: TransactionDb) => Promise<T> | T,
): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${scope.organizationId}, true)`;
    await tx`select set_config('app.authenticating_user_id', ${scope.userId}, true)`;
    return callback(tx);
  }) as Promise<T>;
}

/** Bascule la transaction courante sur un autre tenant (lecture ou écriture qui le vise). */
export async function scopeToOrganization(tx: TransactionDb, organizationId: string): Promise<void> {
  await tx`select set_config('app.organization_id', ${organizationId}, true)`;
}

/** Vrai quand l'espace a demandé la suppression de son compte et que la purge attend ou court. */
export async function hasPendingAccountDeletion(db: Db, organizationId: string): Promise<boolean> {
  const rows = await db.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    return tx<Array<{ exists: boolean }>>`
      select exists(
        select 1 from tenant_deletions
         where organization_id = ${organizationId} and reason = 'account_deleted'
      ) as exists
    `;
  }) as Array<{ exists: boolean }>;
  return Boolean(rows[0]?.exists);
}

export async function readTenantDeletion(
  tx: TransactionDb,
  organizationId: string,
  options: { lock?: boolean } = {},
): Promise<TenantDeletionRow | null> {
  const rows = options.lock
    ? await tx<TenantDeletionRow[]>`
        select reason, requested_at as "requestedAt", purge_after as "purgeAfter",
               started_at as "startedAt", lease_expires_at as "leaseExpiresAt"
          from tenant_deletions where organization_id = ${organizationId}
          for update
      `
    : await tx<TenantDeletionRow[]>`
        select reason, requested_at as "requestedAt", purge_after as "purgeAfter",
               started_at as "startedAt", lease_expires_at as "leaseExpiresAt"
          from tenant_deletions where organization_id = ${organizationId}
      `;
  return rows[0] ?? null;
}

/**
 * Programme (ou reprogramme) la purge d'un compte supprimé. La date de la
 * demande et la fin de grâce d'une demande déjà `account_deleted` sont
 * conservées ; tout le reste de l'état de réclamation repart de zéro.
 */
export async function requestAccountDeletion(
  tx: TransactionDb,
  organizationId: string,
  graceDays: number,
): Promise<TenantDeletionRow> {
  const rows = await tx<TenantDeletionRow[]>`
    insert into tenant_deletions (organization_id, reason, purge_after)
    values (
      ${organizationId}, 'account_deleted',
      now() + (${graceDays} * interval '1 day')
    )
    on conflict (organization_id) do update set
      reason = excluded.reason,
      requested_at = case
        when tenant_deletions.reason = 'account_deleted' then tenant_deletions.requested_at
        else now()
      end,
      purge_after = case
        when tenant_deletions.reason = 'account_deleted'
          and tenant_deletions.purge_after is not null then tenant_deletions.purge_after
        else excluded.purge_after
      end,
      started_at = null,
      lease_owner = null,
      lease_expires_at = null,
      attempts = 0,
      last_attempt_at = null,
      completed_at = null,
      last_error = null
    returning reason, requested_at as "requestedAt", purge_after as "purgeAfter",
              started_at as "startedAt", lease_expires_at as "leaseExpiresAt"
  `;
  return rows[0]!;
}

/** Annule une suppression de compte que le worker n'a pas encore réclamée. */
export async function cancelUnclaimedAccountDeletion(tx: TransactionDb, organizationId: string): Promise<void> {
  await tx`
    delete from tenant_deletions
     where organization_id = ${organizationId}
       and reason = 'account_deleted' and started_at is null
  `;
}

/**
 * Un réabonnement annule une purge programmée, qu'elle soit encore en
 * attente ou déjà réclamée par le worker (la ligne disparaît dans les deux cas).
 */
export async function cancelPendingTenantDeletion(tx: TransactionDb, organizationId: string): Promise<void> {
  await tx`delete from tenant_deletions where organization_id = ${organizationId}`;
}

/**
 * Programme la purge d'un espace dont l'abonnement s'est terminé : la ligne
 * porte `purge_after` (fin du délai de grâce), le worker ne purge qu'ensuite.
 */
export async function scheduleSubscriptionEndedDeletion(
  tx: TransactionDb,
  organizationId: string,
  graceDays: number,
): Promise<void> {
  await tx`
    insert into tenant_deletions (organization_id, reason, purge_after)
    values (${organizationId}, 'subscription_ended', now() + (${graceDays} * interval '1 day'))
    on conflict (organization_id) do update set requested_at = now(), completed_at = null,
      last_error = null, purge_after = now() + (${graceDays} * interval '1 day')
  `;
}

// ---------------------------------------------------------------------------
// Worker side: claim, lease and finalize a tenant purge.
//
// Lock order shared with the API and the payment webhook: subscription first
// (`subscriptionPort().status` with `lock`, implemented by billing), then
// the organization, then the `tenant_deletions` row.
// ---------------------------------------------------------------------------

export type TenantDeletionTask = { organizationId: string; reason: string };

/** `driver` : le magasin de l'objet (0171) ; null pour une ligne qui ne le sait pas. */
export type ClaimedBlobDeletion = { organizationId: string; key: string; attempts: number; driver: "file" | "r2" | null };

/**
 * Une purge est prête quand sa grâce est échue, qu'aucune importation ou
 * suppression de profil ni aucun run actif ne tient l'organisation, et que
 * personne ne tient déjà son bail. Les tables `profile_*` et `runs` ne sont
 * que LUES ici.
 */
export async function findDeletionCandidate(tx: TransactionDb, maxAttempts: number): Promise<TenantDeletionTask | null> {
  const candidates = await tx<TenantDeletionTask[]>`
    select organization_id as "organizationId", reason from tenant_deletions
     where completed_at is null and attempts < ${maxAttempts}
       and (started_at is null or lease_expires_at <= now())
       and (purge_after is null or purge_after <= now())
       and not exists (
         select 1 from profile_import_jobs j where j.organization_id = tenant_deletions.organization_id
           and j.status in ('queued','running','needs_attention')
       )
       and not exists (
         select 1 from profile_delete_jobs d where d.organization_id = tenant_deletions.organization_id
           and d.status in ('queued','running')
       )
       and not exists (
         select 1 from runs
          where organization_id = tenant_deletions.organization_id
            and status in ('queued','starting','running','awaiting_approval','relaying','unknown')
       )
     order by requested_at asc limit 1
  `;
  return candidates[0] ?? null;
}

/** Même prédicat que `findDeletionCandidate`, ligne verrouillée : on la réclame après avoir verrouillé l'abonnement. */
export async function lockDeletionCandidate(
  tx: TransactionDb,
  organizationId: string,
  maxAttempts: number,
): Promise<TenantDeletionTask | null> {
  const rows = await tx<TenantDeletionTask[]>`
    select organization_id as "organizationId", reason from tenant_deletions
     where organization_id = ${organizationId}
       and completed_at is null and attempts < ${maxAttempts}
       and (started_at is null or lease_expires_at <= now())
       and (purge_after is null or purge_after <= now())
       and not exists (
         select 1 from profile_import_jobs j where j.organization_id = tenant_deletions.organization_id
           and j.status in ('queued','running','needs_attention')
       )
       and not exists (
         select 1 from profile_delete_jobs d where d.organization_id = tenant_deletions.organization_id
           and d.status in ('queued','running')
       )
       and not exists (
         select 1 from runs
          where organization_id = tenant_deletions.organization_id
            and status in ('queued','starting','running','awaiting_approval','relaying','unknown')
       )
     for update skip locked
  `;
  return rows[0] ?? null;
}

/** Un abonnement redevenu actif pendant la grâce retire la purge non commencée. */
export async function deleteUnclaimedDeletion(tx: TransactionDb, organizationId: string): Promise<void> {
  await tx`
    delete from tenant_deletions where organization_id = ${organizationId}
      and (started_at is null or lease_expires_at <= now())
  `;
}

export async function startDeletionLease(
  tx: TransactionDb,
  organizationId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<void> {
  await tx`
    update tenant_deletions set started_at = coalesce(started_at, now()),
      lease_owner = ${workerId},
      lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
      attempts = attempts + 1, last_attempt_at = now(), last_error = null
     where organization_id = ${organizationId}
  `;
}

/** Vrai quand le bail de ce worker était encore tenu et a été prolongé. */
export async function renewDeletionLease(
  db: Db,
  workerId: string,
  organizationId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const rows = await db<Array<{ organizationId: string }>>`
    update tenant_deletions set
      lease_expires_at = now() + (${leaseSeconds} * interval '1 second')
     where organization_id = ${organizationId} and lease_owner = ${workerId}
     returning organization_id as "organizationId"
  `;
  return Boolean(rows[0]);
}

/** Rend la purge réclamable de nouveau après un échec, en gardant la raison. */
export async function releaseDeletionLease(
  db: Db,
  workerId: string,
  organizationId: string,
  error: string,
): Promise<void> {
  await db`
    update tenant_deletions set started_at = null, lease_owner = null, lease_expires_at = null,
      last_error = ${error}
     where organization_id = ${organizationId} and lease_owner = ${workerId}
  `;
}

/** Lecture seule de `profile_import_jobs` (propriétaire : portability). */
export async function hasActiveProfileImport(tx: TransactionDb, organizationId: string): Promise<boolean> {
  const imports = await tx<Array<{ id: string }>>`select id from profile_import_jobs where organization_id = ${organizationId} and status in ('queued','running','needs_attention') limit 1`;
  return imports.length > 0;
}

/** Lecture seule de `profile_delete_jobs` (propriétaire : portability). */
export async function hasActiveProfileDelete(tx: TransactionDb, organizationId: string): Promise<boolean> {
  const deletes = await tx<Array<{ id: string }>>`select id from profile_delete_jobs where organization_id = ${organizationId} and status in ('queued','running') limit 1`;
  return deletes.length > 0;
}

/** Verrouille l'organisation : plus aucune ligne enfant ne naît pendant que le manifeste de blobs est figé. */
export async function lockOrganizationForPurge(tx: TransactionDb, organizationId: string): Promise<boolean> {
  const organizations = await tx<Array<{ id: string }>>`
    select id from organizations where id = ${organizationId} for update
  `;
  return Boolean(organizations[0]);
}

/** La raison de la purge si CE worker en tient encore le bail, verrouillée ; null sinon. */
export async function lockOwnedDeletion(
  tx: TransactionDb,
  organizationId: string,
  workerId: string,
): Promise<string | null> {
  const deletion = await tx<Array<{ reason: string }>>`
    select reason from tenant_deletions
     where organization_id = ${organizationId}
       and lease_owner = ${workerId} and lease_expires_at > now()
     for update
  `;
  return deletion[0]?.reason ?? null;
}

export async function deleteOwnedDeletion(tx: TransactionDb, organizationId: string, workerId: string): Promise<void> {
  await tx`
    delete from tenant_deletions where organization_id = ${organizationId}
      and lease_owner = ${workerId} and lease_expires_at > now()
  `;
}

export async function listAccountUsers(
  tx: TransactionDb,
  organizationId: string,
): Promise<Array<{ userId: string; email: string }>> {
  return tx<Array<{ userId: string; email: string }>>`
    select m.user_id as "userId", u.email as "email"
      from memberships m join users u on u.id = m.user_id
     where m.organization_id = ${organizationId} and m.revoked_at is null
  `;
}

/**
 * Fige le manifeste des blobs du tenant dans l'outbox durable avant la purge :
 * pièces jointes et manifestes d'ingestion (lus dans `attachments` et
 * `message_ingress`, propriété de conversation). Rend le nombre de clés.
 */
export async function manifestTenantBlobs(tx: TransactionDb, organizationId: string): Promise<number> {
  // Le driver de la pièce jointe suit sa clé ; une clé connue du seul
  // manifeste d'ingestion n'en a pas (null : tous les magasins joignables).
  const manifested = await tx<Array<{ key: string }>>`
    with object_keys as (
      select object_key as key, driver from attachments where organization_id = ${organizationId}
      union
      select item->>'key' as key, null as driver from message_ingress ingress
      cross join lateral jsonb_array_elements(ingress.attachment_manifest) item
       where ingress.organization_id = ${organizationId}
         and jsonb_typeof(item) = 'object' and item ? 'key'
    )
    insert into tenant_blob_deletions (object_key, organization_id, driver)
    select distinct on (key) key, ${organizationId}, driver from object_keys where key is not null
     order by key, driver nulls last
    on conflict (object_key) do nothing
    returning object_key as key
  `;
  return manifested.length;
}

/** La cascade des clés étrangères emporte les tables du tenant ; vrai quand l'organisation existait. */
export async function deleteOrganization(tx: TransactionDb, organizationId: string): Promise<boolean> {
  const deleted = await tx<Array<{ id: string }>>`
    delete from organizations where id = ${organizationId}
    returning id
  `;
  return Boolean(deleted[0]);
}

export type AccountUserErasure = "deleted" | "pseudonymized" | "kept" | "absent";

/**
 * Efface le compte qui n'a plus aucune adhésion VIVANTE, comme l'éligibilité
 * le promet (`listOtherMemberships` ignore les adhésions révoquées). Sans
 * aucune adhésion, la ligne part. Avec des adhésions révoquées, elles portent
 * l'historique d'autres tenants (décisions, invitations…) que la suppression
 * emporterait ou bloquerait : le compte est alors pseudonymisé (adresse,
 * identifiants de connexion et sessions effacés). Le worker n'a aucun droit
 * d'écriture sur `users` ni sur `sessions` : la fonction SECURITY DEFINER de
 * 0171 porte seule ces règles.
 */
export async function eraseAccountUser(tx: TransactionDb, userId: string): Promise<AccountUserErasure> {
  const rows = await tx<Array<{ outcome: AccountUserErasure }>>`
    select public.erase_account_user(${userId}::uuid) as outcome
  `;
  const outcome = rows[0]?.outcome;
  if (outcome !== "deleted" && outcome !== "pseudonymized" && outcome !== "kept" && outcome !== "absent") {
    throw new Error("Unexpected account erasure outcome.");
  }
  return outcome;
}

/** Réclame un lot de blobs à supprimer (bail court, `skip locked` : plusieurs workers ne se marchent pas dessus). */
export async function claimBlobDeletions(
  db: Db,
  workerId: string,
  leaseSeconds: number,
  batchSize: number,
  organizationId?: string,
): Promise<ClaimedBlobDeletion[]> {
  return await db.begin(async (tx) => tx<ClaimedBlobDeletion[]>`
    with candidates as (
      select object_key from tenant_blob_deletions
       where available_at <= now()
         and (lease_owner is null or lease_expires_at is null or lease_expires_at <= now())
         and (${organizationId ?? null}::uuid is null or organization_id = ${organizationId ?? null})
       order by available_at asc, created_at asc
       for update skip locked
       limit ${batchSize}
    )
    update tenant_blob_deletions deletion set lease_owner = ${workerId},
      lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
      attempts = deletion.attempts + 1, last_error = null
     from candidates where deletion.object_key = candidates.object_key
    returning deletion.organization_id as "organizationId", deletion.object_key as key, deletion.attempts,
              deletion.driver
  `) as ClaimedBlobDeletion[];
}

export async function completeBlobDeletion(db: Db, key: string, workerId: string): Promise<void> {
  await db`
    delete from tenant_blob_deletions where object_key = ${key}
      and lease_owner = ${workerId}
  `;
}

export async function retryBlobDeletionLater(
  db: Db,
  key: string,
  workerId: string,
  delaySeconds: number,
  error: string,
): Promise<void> {
  await db`
    update tenant_blob_deletions set lease_owner = null, lease_expires_at = null,
      available_at = now() + (${delaySeconds} * interval '1 second'),
      last_error = ${error}
     where object_key = ${key} and lease_owner = ${workerId}
  `;
}
