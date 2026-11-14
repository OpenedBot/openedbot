import type { TransactionDb } from "@openedbot/platform-db";

/** Le nom d'utilisateur de l'opérateur de l'organisation (`operator_profiles`), créé ou remplacé. */
export async function upsertOperatorProfile(
  tx: TransactionDb,
  organizationId: string,
  username: string,
): Promise<{ username: string; updatedAt: Date | string }> {
  const rows = await tx<Array<{ username: string; updatedAt: Date | string }>>`
    insert into operator_profiles (organization_id, username)
    values (${organizationId}, ${username})
    on conflict (organization_id) do update set username = excluded.username, updated_at = now()
    returning username, updated_at as "updatedAt"
  `;
  return rows[0]!;
}

/**
 * Fusionne le corps d'onboarding dans le jsonb de l'organisation. Le nom
 * d'espace EST le nom de l'organisation : les deux valeurs sont écrites par
 * la même instruction.
 */
export async function mergeOrganizationOnboarding(
  tx: TransactionDb,
  organizationId: string,
  body: Record<string, unknown>,
  workspaceName: string | null,
): Promise<void> {
  await tx`
    update organizations set onboarding = (coalesce(onboarding, '{}'::jsonb) - 'organizationReset') || ${body},
      name = coalesce(${workspaceName}::text, name), updated_at = now()
     where id = ${organizationId}
  `;
}

/** L'espace date sa sortie de l'accueil et garde son chemin de sortie, idempotents. */
export async function completeOrganizationOnboarding(
  tx: TransactionDb,
  organizationId: string,
  completionPath: string,
): Promise<void> {
  await tx`
    update organizations set onboarded_at = coalesce(onboarded_at, now()),
      onboarding = (coalesce(onboarding, '{}'::jsonb) - 'organizationReset') || jsonb_build_object('completionPath', ${completionPath}::text),
      updated_at = now() where id = ${organizationId}
  `;
}

/** La sortie de l'accueil est un fait sur la PERSONNE (`users.onboarding_completed`, 0025). */
export async function markUserOnboardingCompleted(tx: TransactionDb, userId: string): Promise<void> {
  await tx`
    update users set onboarding_completed = true, updated_at = now()
     where id = ${userId} and onboarding_completed = false
  `;
}

/** Outil de développement : l'espace repart d'un accueil vierge, marqué `organizationReset`. */
export async function markOrganizationOnboardingReset(tx: TransactionDb, organizationId: string): Promise<void> {
  await tx`
    update organizations
       set onboarding = jsonb_build_object('organizationReset', true),
           onboarded_at = null, updated_at = now()
     where id = ${organizationId}
  `;
}

/** Outil de développement : la personne rejoue l'accueil. */
export async function resetUserOnboarding(tx: TransactionDb, userId: string): Promise<void> {
  await tx`
    update users set onboarding_completed = false, updated_at = now()
     where id = ${userId}
  `;
}

/** Outil de développement : l'espace oublie sa date de sortie et ses réponses. */
export async function clearOrganizationOnboarding(tx: TransactionDb, organizationId: string): Promise<void> {
  await tx`
    update organizations set onboarded_at = null, onboarding = null, updated_at = now()
     where id = ${organizationId}
  `;
}
