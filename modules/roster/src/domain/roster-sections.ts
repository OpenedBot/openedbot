import type { SectionDto } from "@openedbot/contracts-api";

/**
 * Les sections de la barre latérale : le modèle de Grok Bot
 * (`sidebar-section-projection.ts`) posé sur les `sections` d'openedbot.
 *
 * Amont, une section est un dossier : l'opérateur y range ses agents en les
 * glissant, et le reste tombe dans un dossier synthétique « Unassigned »,
 * verrouillé, toujours en dernier. Ici chaque bot a déjà une `section_id`
 * (non nulle) : la section par défaut : la première par rang, celle où
 * `POST /api/bots` range un bot sans section : joue ce rôle. Elle est rendue
 * en dernier, sous un libellé fixe, et ne se renomme, ne se déplace ni ne se
 * supprime. Elle se replie, comme les autres : son en-tête porte un chevron
 * et `aria-expanded`, un clic qui ne ferait rien serait un bouton menteur.
 *
 * Tant qu'il n'y a QUE la section par défaut, la liste reste plate : un
 * en-tête « Non assigné » au-dessus de tous les bots n'apprendrait rien.
 */
export type RosterSectionProjection<Row> = {
  id: string;
  name: string;
  position: number;
  collapsed: boolean;
  /** La section par défaut : ni renommage, ni déplacement, ni suppression. */
  locked: boolean;
  rows: Row[];
};

export type RosterSectionsProjection<Row> = {
  /** Aucune section éditable : la liste se rend sans en-tête. */
  flat: boolean;
  defaultSectionId: string | null;
  sections: RosterSectionProjection<Row>[];
};

/** La section par défaut : la première par rang. `null` sans section. */
export function defaultSectionId(sections: ReadonlyArray<Pick<SectionDto, "id" | "position">>): string | null {
  let found: Pick<SectionDto, "id" | "position"> | null = null;
  for (const section of sections) {
    if (found === null || section.position < found.position) found = section;
  }
  return found?.id ?? null;
}

export function projectRosterSections<Row>(input: {
  sections: ReadonlyArray<SectionDto>;
  rows: ReadonlyArray<Row>;
  sectionIdOf: (row: Row) => string;
  /**
   * Le rang manuel d'une ligne dans sa section (`position`). Fourni, les
   * lignes d'une section se rangent par ce rang, c'est l'ordre que le
   * glisser-déposer écrit ; absent, l'ordre reçu (activité) est conservé.
   */
  positionOf?: (row: Row) => number;
}): RosterSectionsProjection<Row> {
  const fallbackId = defaultSectionId(input.sections);
  const ordered = [...input.sections].sort((a, b) => a.position - b.position);
  const editable = ordered.filter((section) => section.id !== fallbackId);
  const fallback = ordered.find((section) => section.id === fallbackId) ?? null;

  // Aucune section (roster pas encore lu) : rien à lister, et surtout pas
  // une section synthétique sans id qu'un « Déplacer vers… » enverrait au
  // serveur.
  if (fallback === null) return { flat: true, defaultSectionId: null, sections: [] };

  if (editable.length === 0) {
    return {
      flat: true,
      defaultSectionId: fallback.id,
      sections: [{
        id: fallback.id,
        name: fallback.name,
        position: fallback.position,
        collapsed: fallback.collapsed,
        locked: true,
        rows: input.positionOf
          ? [...input.rows].map((row, index) => ({ row, index })).sort((a, b) => input.positionOf!(a.row) - input.positionOf!(b.row) || a.index - b.index).map((item) => item.row)
          : [...input.rows],
      }],
    };
  }

  const editableIds = new Set(editable.map((section) => section.id));
  const rowsBySection = new Map<string, Row[]>();
  // Une ligne dont la section n'existe plus côté client : un roster lu
  // avant la suppression : retombe dans la section par défaut plutôt que
  // de disparaître.
  for (const row of input.rows) {
    const sectionId = input.sectionIdOf(row);
    const key = editableIds.has(sectionId) ? sectionId : fallback.id;
    const bucket = rowsBySection.get(key);
    if (bucket) bucket.push(row);
    else rowsBySection.set(key, [row]);
  }

  const byPosition = input.positionOf;
  const orderedRows = (rows: Row[]): Row[] =>
    byPosition ? rows.map((row, index) => ({ row, index })).sort((a, b) => byPosition(a.row) - byPosition(b.row) || a.index - b.index).map((item) => item.row) : rows;
  const project = (section: SectionDto, locked: boolean): RosterSectionProjection<Row> => ({
    id: section.id,
    name: section.name,
    position: section.position,
    collapsed: section.collapsed,
    locked,
    rows: orderedRows(rowsBySection.get(section.id) ?? []),
  });

  return {
    flat: false,
    defaultSectionId: fallback.id,
    sections: [...editable.map((section) => project(section, false)), project(fallback, true)],
  };
}

export type RosterSectionMoveState = {
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Le rang à demander pour monter / descendre : un échange avec la voisine. */
  upPosition: number | null;
  downPosition: number | null;
};

/**
 * Monter ou descendre une section, c'est prendre le rang de sa voisine
 * éditable : la section par défaut ne bouge pas et n'est jamais une voisine.
 */
export function rosterSectionMoveState<Row>(
  sections: ReadonlyArray<RosterSectionProjection<Row>>,
  sectionId: string,
): RosterSectionMoveState {
  const editable = sections.filter((section) => !section.locked);
  const index = editable.findIndex((section) => section.id === sectionId);
  if (index === -1) return { canMoveUp: false, canMoveDown: false, upPosition: null, downPosition: null };
  const up = index > 0 ? editable[index - 1] : null;
  const down = index < editable.length - 1 ? editable[index + 1] : null;
  return {
    canMoveUp: up !== null,
    canMoveDown: down !== null,
    upPosition: up?.position ?? null,
    downPosition: down?.position ?? null,
  };
}
