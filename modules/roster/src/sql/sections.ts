import type { TransactionDb } from "@openedbot/platform-db";
import { moveTeamImportsToSection } from "@openedbot/portability/sql/team-imports";

export type SectionRow = { id: string; name: string; position: number; collapsed: boolean; context?: string };

/**
 * Le prochain rang libre d'une section, une ligne qui y arrive (création ou
 * déplacement) se range en dernier. Bots et salons partagent le même ordre
 * (`PUT /api/sections/:id/order` les entrelace) : le maximum se prend sur
 * les deux tables, sinon un bot neuf prendrait le rang d'un salon.
 *
 * La ligne de section est verrouillée jusqu'à la fin de la transaction :
 * deux créations simultanées liraient le même maximum et partageraient un
 * rang. `orderSection` prend le même verrou, une réécriture d'ordre ne se
 * croise pas avec une arrivée. `exclude` : la ligne déplacée ne compte pas.
 */
export async function nextSectionRowPosition(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
  exclude?: { kind: "bot" | "group"; id: string },
): Promise<number> {
  await lockSectionRow(tx, organizationId, sectionId);
  const excludedBot = exclude?.kind === "bot" ? exclude.id : null;
  const excludedGroup = exclude?.kind === "group" ? exclude.id : null;
  const positions = await tx<Array<{ next: number }>>`
    select coalesce(greatest(
      (select max(position) from bots
        where organization_id = ${organizationId} and section_id = ${sectionId}
          and (${excludedBot}::uuid is null or id <> ${excludedBot}::uuid)),
      (select max(position) from bot_groups
        where organization_id = ${organizationId} and section_id = ${sectionId}
          and (${excludedGroup}::uuid is null or id <> ${excludedGroup}::uuid))
    ), -1) + 1 as next
  `;
  return Number(positions[0]?.next ?? 0);
}

/** Verrouille la section pour la transaction ; `false` si elle n'existe pas. */
export async function lockSectionRow(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
): Promise<boolean> {
  const locked = await tx<Array<{ id: string }>>`
    select id from sections
     where organization_id = ${organizationId} and id = ${sectionId}
     for update
  `;
  return Boolean(locked[0]);
}

/** Les sections de l'organisation, dans l'ordre d'affichage. */
export function readSections(tx: TransactionDb, organizationId: string): Promise<SectionRow[]> {
  return tx<SectionRow[]>`
    select id, name, position, collapsed, context from sections
     where organization_id = ${organizationId} order by position asc
  `;
}

/** La section par défaut : la première par rang, celle où un bot sans section est rangé. */
export async function readDefaultSectionId(tx: TransactionDb, organizationId: string): Promise<string | null> {
  const sections = await tx<Array<{ id: string }>>`
    select id from sections where organization_id = ${organizationId} order by position asc limit 1
  `;
  return sections[0]?.id ?? null;
}

/** Crée la section par défaut d'une organisation qui n'en a encore aucune. */
export async function insertDefaultSection(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
): Promise<void> {
  await tx`
    insert into sections (id, organization_id, name, position)
    values (${sectionId}, ${organizationId}, 'Bots', 0)
  `;
}

export async function sectionExists(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
): Promise<boolean> {
  const sections = await tx<Array<{ id: string }>>`
    select id from sections
     where organization_id = ${organizationId} and id = ${sectionId}
     limit 1
  `;
  return Boolean(sections[0]);
}

/**
 * `unique (organization_id, position)` : deux créations simultanées (double
 * dépôt, double clic) liraient le même `max(position)` et la seconde tomberait
 * en 23505. Le verrou sérialise par organisation.
 */
export async function insertSection(
  tx: TransactionDb,
  organizationId: string,
  name: string,
): Promise<SectionRow[]> {
  await tx`select pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('sections'))`;
  return tx<SectionRow[]>`
    insert into sections (id, organization_id, name, position)
    values (
      ${crypto.randomUUID()}, ${organizationId}, ${name},
      (select coalesce(max(position), -1) + 1 from sections where organization_id = ${organizationId})
    ) returning id, name, position, collapsed, context
  `;
}

export async function readSectionPosition(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
): Promise<number | null> {
  const current = await tx<Array<{ position: number }>>`
    select position from sections
     where organization_id = ${organizationId} and id = ${sectionId}
  `;
  return current[0] ? Number(current[0].position) : null;
}

/**
 * `unique (organization_id, position)` : deux sections ne partagent jamais un
 * rang, donc « monter » est un ÉCHANGE avec la section qui occupe déjà la place
 * visée : via un rang temporaire, sinon le premier `update` viole la
 * contrainte avant que le second la répare.
 */
export async function swapSectionPosition(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
  from: number,
  to: number,
): Promise<void> {
  await tx`
    update sections set position = -1
     where organization_id = ${organizationId} and position = ${to}
  `;
  await tx`
    update sections set position = ${to}, updated_at = now()
     where organization_id = ${organizationId} and id = ${sectionId}
  `;
  await tx`
    update sections set position = ${from}, updated_at = now()
     where organization_id = ${organizationId} and position = -1
  `;
}

export function updateSection(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
  patch: { name: string | null; collapsed: boolean | null; context: string | null },
): Promise<SectionRow[]> {
  return tx<SectionRow[]>`
    update sections set
      name = coalesce(${patch.name}, name),
      collapsed = coalesce(${patch.collapsed}, collapsed),
      context = coalesce(${patch.context}, context),
      updated_at = now()
    where organization_id = ${organizationId} and id = ${sectionId}
    returning id, name, position, collapsed, context
  `;
}

/** Une ligne citée par l'ordre rejoint la section et prend son rang ; `false` si la ligne n'existe pas. */
export async function placeInSection(
  tx: TransactionDb,
  organizationId: string,
  kind: "bot" | "group",
  rowId: string,
  sectionId: string,
  position: number,
): Promise<boolean> {
  const updated = kind === "bot"
    ? await tx<Array<{ id: string }>>`
        update bots set section_id = ${sectionId}, position = ${position}, updated_at = now()
         where organization_id = ${organizationId} and id = ${rowId} returning id
      `
    : await tx<Array<{ id: string }>>`
        update bot_groups set section_id = ${sectionId}, position = ${position}, updated_at = now()
         where organization_id = ${organizationId} and id = ${rowId} returning id
      `;
  return Boolean(updated[0]);
}

/** Les identifiants de section dans l'ordre d'affichage : le premier est la section par défaut. */
export async function readSectionIdsInOrder(tx: TransactionDb, organizationId: string): Promise<string[]> {
  const sections = await tx<Array<{ id: string }>>`
    select id from sections where organization_id = ${organizationId} order by position asc
  `;
  return sections.map((section) => section.id);
}

/**
 * Supprimer une section ne supprime rien d'autre : ses bots, ses salons et ses
 * imports d'équipe rejoignent la section de repli.
 */
export async function deleteSectionMovingRows(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
  fallbackId: string,
): Promise<void> {
  await tx`
    update bots set section_id = ${fallbackId}, updated_at = now()
     where organization_id = ${organizationId} and section_id = ${sectionId}
  `;
  await tx`
    update bot_groups set section_id = ${fallbackId}, updated_at = now()
     where organization_id = ${organizationId} and section_id = ${sectionId}
  `;
  // Un import d'équipe garde la section où il a posé ses bots
  // (`team_imports.section_id`, sans `on delete`) : il suit, sinon la
  // suppression casse en 23503 sur toute section qui a reçu un import.
  await moveTeamImportsToSection(tx, organizationId, sectionId, fallbackId);
  await tx`
    delete from sections where organization_id = ${organizationId} and id = ${sectionId}
  `;
}

/**
 * Réécrit le rang des sections éditables : `order[i]` passe juste après la
 * section par défaut, à `defaultPosition + 1 + i`. `unique (organization_id,
 * position)` : tout le monde part d'abord sur un rang négatif distinct
 * (`-1 - position`), sinon la première écriture heurte une voisine.
 */
export async function writeSectionsOrder(
  tx: TransactionDb,
  organizationId: string,
  defaultSectionId: string,
  order: ReadonlyArray<string>,
): Promise<void> {
  const base = await readSectionPosition(tx, organizationId, defaultSectionId);
  if (base === null) return;
  await tx`
    update sections set position = -1 - position
     where organization_id = ${organizationId} and id <> ${defaultSectionId}
  `;
  for (const [index, sectionId] of order.entries()) {
    await tx`
      update sections set position = ${base + 1 + index}, updated_at = now()
       where organization_id = ${organizationId} and id = ${sectionId}
    `;
  }
}

/** Une ligne citée par l'ordre des épinglés : épinglée, à ce rang ; `false` si elle n'existe pas. */
export async function placeInPins(
  tx: TransactionDb,
  organizationId: string,
  kind: "bot" | "group",
  rowId: string,
  position: number,
): Promise<boolean> {
  const updated = kind === "bot"
    ? await tx<Array<{ id: string }>>`
        update bots set pinned = true, pin_position = ${position}, updated_at = now()
         where organization_id = ${organizationId} and id = ${rowId} returning id
      `
    : await tx<Array<{ id: string }>>`
        update bot_groups set pinned = true, pin_position = ${position}, updated_at = now()
         where organization_id = ${organizationId} and id = ${rowId} returning id
      `;
  return Boolean(updated[0]);
}

/** Sérialise les écritures de rang des sections d'une organisation (création, réordonnancement). */
export async function lockSections(tx: TransactionDb, organizationId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('sections'))`;
}
