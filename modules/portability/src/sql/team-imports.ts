import type { TransactionDb } from "@openedbot/platform-db";

/**
 * `team_imports.section_id` n'a pas de `on delete` : un import d'équipe garde la
 * section où il a posé ses bots, et suit son bot quand cette section disparaît.
 * La table appartient à `portability` ; le roster passe par ces deux fonctions
 * quand il supprime ou purge une section.
 */

/** Rattache les imports d'équipe de ces sections à la section par défaut (première par rang). */
export async function moveTeamImportsToDefaultSection(
  tx: TransactionDb,
  organizationId: string,
  sectionIds: readonly string[],
): Promise<void> {
  await tx`
    update team_imports set section_id = (
      select id from sections where organization_id = ${organizationId} order by position asc limit 1
    )
     where organization_id = ${organizationId} and section_id in ${tx(sectionIds)}
  `;
}

/** Rattache les imports d'équipe d'une section à la section de repli. */
export async function moveTeamImportsToSection(
  tx: TransactionDb,
  organizationId: string,
  fromSectionId: string,
  toSectionId: string,
): Promise<void> {
  await tx`
    update team_imports set section_id = ${toSectionId}
     where organization_id = ${organizationId} and section_id = ${fromSectionId}
  `;
}
