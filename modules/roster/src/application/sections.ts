import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type { SectionPatchInput } from "../domain/section-input";
import { pruneEmptySections } from "../sql/section-prune";
import {
  deleteSectionMovingRows,
  insertSection,
  lockSectionRow,
  lockSections,
  placeInPins,
  placeInSection,
  readSectionIdsInOrder,
  readSectionPosition,
  swapSectionPosition,
  updateSection,
  writeSectionsOrder,
  type SectionRow,
} from "../sql/sections";

export async function createSection(db: Db, organizationId: string, name: string): Promise<SectionRow> {
  const rows = await withTenant(db, organizationId, (tx) => insertSection(tx, organizationId, name));
  return rows[0]!;
}

export async function patchSection(
  db: Db,
  organizationId: string,
  sectionId: string,
  patch: SectionPatchInput,
): Promise<SectionRow> {
  const rows = await withTenant(db, organizationId, async (tx) => {
    // `unique (organization_id, position)` : deux sections ne partagent
    // jamais un rang, donc « monter » est un ÉCHANGE avec la section qui
    // occupe déjà la place visée.
    if (patch.position !== null) {
      const from = await readSectionPosition(tx, organizationId, sectionId);
      if (from === null) throw new HttpError(404, "SECTION_NOT_FOUND", "Section introuvable.");
      if (from !== patch.position) await swapSectionPosition(tx, organizationId, sectionId, from, patch.position);
    }
    return updateSection(tx, organizationId, sectionId, patch);
  });
  if (!rows[0]) throw new HttpError(404, "SECTION_NOT_FOUND", "Section introuvable.");
  return rows[0];
}

// L'ordre d'une section, tel qu'affiché : bots et salons entrelacés, un
// rang par ligne. Chaque ligne citée rejoint la section (déplacement) et
// prend son index : une seule écriture atomique pour un dépôt, qu'il
// range dans la même section ou dans une autre.
export async function orderSection(
  db: Db,
  organizationId: string,
  sectionId: string,
  order: ReadonlyArray<{ kind: "bot" | "group"; id: string }>,
): Promise<void> {
  await withTenant(db, organizationId, async (tx) => {
    // Verrouillée comme pour une arrivée (`nextSectionRowPosition`) : un bot
    // créé pendant la réécriture ne prend pas un rang qu'elle attribue.
    if (!(await lockSectionRow(tx, organizationId, sectionId))) {
      throw new HttpError(404, "SECTION_NOT_FOUND", "Section introuvable.");
    }
    for (const [position, item] of order.entries()) {
      if (!(await placeInSection(tx, organizationId, item.kind, item.id, sectionId, position))) {
        throw new HttpError(404, "SECTION_ORDER_ROW_NOT_FOUND", "Une ligne de l'ordre demandé n'existe pas.");
      }
    }
    await pruneEmptySections(tx, organizationId);
  });
}

// L'ordre des sections éditables, tel qu'affiché de haut en bas. La section
// par défaut (première par rang) n'y figure pas et garde sa place : c'est
// elle qui reçoit les bots sans section. L'ordre doit citer exactement les
// sections éditables : une liste périmée (section créée ou purgée entre la
// lecture et le dépôt) est refusée plutôt qu'appliquée à moitié.
export async function orderSections(db: Db, organizationId: string, order: ReadonlyArray<string>): Promise<void> {
  await withTenant(db, organizationId, async (tx) => {
    await lockSections(tx, organizationId);
    const [defaultId, ...editable] = await readSectionIdsInOrder(tx, organizationId);
    if (!defaultId) throw new HttpError(404, "SECTION_NOT_FOUND", "Section introuvable.");
    const known = new Set(editable);
    if (order.length !== editable.length || order.some((id) => !known.has(id))) {
      throw new HttpError(409, "SECTIONS_ORDER_STALE", "Les sections ont changé entre-temps : rechargez et recommencez.");
    }
    await writeSectionsOrder(tx, organizationId, defaultId, order);
  });
}

// L'ordre de la grille des épinglés, bots et salons entrelacés. Chaque ligne
// citée est épinglée et prend son rang : épingler à un endroit et réordonner
// sont la même écriture atomique. Sa section ne change pas.
export async function orderPins(
  db: Db,
  organizationId: string,
  order: ReadonlyArray<{ kind: "bot" | "group"; id: string }>,
): Promise<void> {
  await withTenant(db, organizationId, async (tx) => {
    for (const [position, item] of order.entries()) {
      if (!(await placeInPins(tx, organizationId, item.kind, item.id, position))) {
        throw new HttpError(404, "SECTION_ORDER_ROW_NOT_FOUND", "Une ligne de l'ordre demandé n'existe pas.");
      }
    }
  });
}

// Supprimer une section ne supprime rien d'autre : ses bots et ses salons
// rejoignent la section par défaut : la première par rang, celle où
// `POST /api/bots` range un bot sans section, « Non assigné » dans la
// barre latérale. Cette section-là ne se supprime pas.
export async function deleteSection(db: Db, organizationId: string, sectionId: string): Promise<void> {
  await withTenant(db, organizationId, async (tx) => {
    const sectionIds = await readSectionIdsInOrder(tx, organizationId);
    const fallbackId = sectionIds[0];
    if (!fallbackId || !sectionIds.includes(sectionId)) {
      throw new HttpError(404, "SECTION_NOT_FOUND", "Section introuvable.");
    }
    if (fallbackId === sectionId) {
      throw new HttpError(409, "SECTION_IS_DEFAULT", "La section par défaut ne se supprime pas.");
    }
    await deleteSectionMovingRows(tx, organizationId, sectionId, fallbackId);
  });
}
