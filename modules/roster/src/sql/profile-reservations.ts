import type { TransactionSQL } from "bun";
import { ProfileImportError } from "../domain/profile-errors";

export async function lockProfileImports(tx: TransactionSQL, organizationId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('hermes-profile-import'))`;
}

/** Caller holds the import lock through the protected operation, not just this read. */
export async function assertProfileNamesAvailable(
  tx: TransactionSQL, organizationId: string, names: readonly string[], ownJobId: string | null = null,
): Promise<void> {
  if (!names.length) return;
  const reserved = await tx<Array<{ slug: string }>>`
    select slug from profile_import_items
     where organization_id = ${organizationId} and reservation_released_at is null
       and slug in (select jsonb_array_elements_text(${JSON.stringify(names)}::text::jsonb))
       and (${ownJobId}::uuid is null or job_id <> ${ownJobId}::uuid) limit 1
  `;
  if (reserved.length) throw reservationError(reserved[0]!.slug);
}

export async function assertNoProfileImportReservations(tx: TransactionSQL, organizationId: string): Promise<void> {
  const reserved = await tx<Array<{ slug: string }>>`
    select slug from profile_import_items where organization_id = ${organizationId}
      and reservation_released_at is null limit 1
  `;
  if (reserved.length) throw reservationError(reserved[0]!.slug);
}

function reservationError(slug: string): ProfileImportError {
  return new ProfileImportError(409, "PROFILE_IMPORT_IN_PROGRESS", `Le profil « ${slug} » est réservé par un import en cours ou à vérifier. Consultez son rapport dans les réglages Hermes.`);
}
