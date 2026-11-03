import { useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { RosterDto } from "@openedbot/contracts-api";
import { toast } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { PINNED_DROP_ID, rosterRowKey, type RosterDragRow, type RosterDropSlot } from "./roster-drag";

/**
 * La file des écritures du roster, une par client de requêtes : toutes les
 * barres et tous les menus qui rangent des lignes la partagent.
 *
 * Un dépôt s'affiche à l'instant (mise à jour optimiste du cache) et son
 * écriture part derrière, sans rien bloquer : on peut enchaîner les dépôts
 * sans attendre le serveur. Les écritures partent une à une, dans l'ordre
 * des gestes : deux `PUT /order` en vol pourraient arriver dans le désordre
 * et laisser l'ordre du premier geste. Le roster n'est relu qu'une fois la
 * file vide : une relecture entre deux écritures ramènerait un ordre
 * intermédiaire et la ligne sauterait en arrière avant de revenir.
 */
type RosterWriteQueue = { tail: Promise<void>; pending: number; stale: boolean };
const writeQueues = new WeakMap<QueryClient, RosterWriteQueue>();

function writeQueueOf(queryClient: QueryClient): RosterWriteQueue {
  let queue = writeQueues.get(queryClient);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0, stale: false };
    writeQueues.set(queryClient, queue);
  }
  return queue;
}

/** Le nombre d'écritures du roster encore en file : pour les tests. */
export function pendingRosterWrites(queryClient: QueryClient): number {
  return writeQueues.get(queryClient)?.pending ?? 0;
}

/**
 * Les écritures de sections de la barre latérale, avec leur mise à jour
 * optimiste du roster en cache : une ligne déposée change de place à
 * l'instant, le serveur confirme derrière. En cas d'échec le roster est relu
 * tel quel une fois la file vide : l'état vrai revient, et le toast dit
 * pourquoi.
 */
export function useRosterSections() {
  const { t } = useT();
  const queryClient = useQueryClient();

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
    [queryClient],
  );
  const patchRoster = useCallback(
    (patch: (roster: RosterDto) => RosterDto) => {
      // Une lecture en vol, partie avant ce geste, écraserait l'optimiste à
      // son retour. Annulée, elle revient à l'état écrit ci-dessous (un
      // `setQueryData` pendant un fetch devient son état de repli).
      void queryClient.cancelQueries({ queryKey: queryKeys.roster });
      queryClient.setQueryData<RosterDto>(queryKeys.roster, (roster) => (roster ? patch(roster) : roster));
    },
    [queryClient],
  );

  /**
   * Met `write` dans la file. `refresh: false` : une écriture dont l'état
   * optimiste suffit (le repli d'une section) ne relit pas le roster.
   * Résout `null` si l'écriture a échoué ; jamais ne rejette.
   */
  const enqueue = useCallback(
    <T,>(write: () => Promise<T>, options: { refresh?: boolean } = {}): Promise<T | null> => {
      const queue = writeQueueOf(queryClient);
      queue.pending += 1;
      const run = queue.tail.then(write);
      queue.tail = run.then(() => undefined, () => undefined);
      return run
        .then(
          (value) => {
            if (options.refresh !== false) queue.stale = true;
            return value;
          },
          (error: unknown) => {
            toast.error(error instanceof ApiError ? error.message : t("botContextMenu.actionFailed"));
            queue.stale = true;
            return null;
          },
        )
        .finally(() => {
          queue.pending -= 1;
          if (queue.pending === 0 && queue.stale) {
            queue.stale = false;
            void invalidate();
          }
        });
    },
    [invalidate, queryClient, t],
  );

  /** L'état optimiste d'une ligne qui rejoint une section (et quitte les épinglés). */
  const patchMove = useCallback(
    (row: RosterDragRow, sectionId: string) => {
      const wasPinned = row.kind === "bot" ? row.bot.pinned : row.group.pinned === true;
      const patch = { sectionId, ...(wasPinned ? { pinned: false } : {}) };
      patchRoster((roster) => ({
        ...roster,
        bots: row.kind === "bot"
          ? roster.bots.map((bot) => (bot.id === row.bot.id ? { ...bot, ...patch } : bot))
          : roster.bots,
        groups: row.kind === "group"
          ? roster.groups?.map((group) => (group.id === row.group.id ? { ...group, ...patch } : group))
          : roster.groups,
      }));
      return patch;
    },
    [patchRoster],
  );
  const writeMove = useCallback(
    async (row: RosterDragRow, patch: { sectionId: string; pinned?: boolean }) => {
      if (row.kind === "bot") await api.updateBot(row.bot.id, patch);
      else await api.updateGroup(row.group.id, patch);
    },
    [],
  );

  /**
   * Une ligne déposée sur une section y va, et quitte les épinglés si elle
   * y était : les épinglés vivent au-dessus des sections, une ligne ne peut
   * pas être aux deux endroits.
   */
  const moveRow = useCallback(
    async (row: RosterDragRow, sectionId: string) => {
      const patch = patchMove(row, sectionId);
      await enqueue(() => writeMove(row, patch));
    },
    [enqueue, patchMove, writeMove],
  );

  /**
   * Une ligne posée À UN ENDROIT d'une section : l'ordre complet de la
   * section est réécrit en une écriture (`PUT /order`) : bots et salons
   * entrelacés, la ligne déplacée à son index, les autres resserrées. Une
   * épinglée qui rejoint une section cesse d'être épinglée. Reposée à sa
   * place, rien ne part.
   */
  const placeRow = useCallback(
    async (row: RosterDragRow, sectionId: string, index: number | null, sectionRows: ReadonlyArray<RosterDragRow>) => {
      const key = rosterRowKey(row);
      const from = sectionRows.findIndex((candidate) => rosterRowKey(candidate) === key);
      const others = sectionRows.filter((candidate) => rosterRowKey(candidate) !== key);
      // Le créneau compte les lignes affichées, la ligne portée comprise ;
      // `others` ne l'a plus : sous sa place, tout recule d'un rang. Sans ce
      // décalage, descendre une ligne d'un cran la posait un cran trop bas.
      const slot = index !== null && from !== -1 && index > from ? index - 1 : index;
      const at = slot === null ? others.length : Math.min(Math.max(slot, 0), others.length);
      const ordered = [...others.slice(0, at), row, ...others.slice(at)];
      const wasPinned = row.kind === "bot" ? row.bot.pinned : row.group.pinned === true;
      const unchanged = !wasPinned
        && ordered.length === sectionRows.length
        && ordered.every((item, position) => rosterRowKey(item) === rosterRowKey(sectionRows[position]!));
      if (unchanged) return;
      const order = ordered.map((item) => ({ kind: item.kind, id: item.kind === "bot" ? item.bot.id : item.group.id }));
      const positionByKey = new Map(order.map((item, position) => [`${item.kind}:${item.id}`, position]));
      patchRoster((roster) => ({
        ...roster,
        bots: roster.bots.map((bot) => {
          const position = positionByKey.get(`bot:${bot.id}`);
          if (position === undefined) return bot;
          const moved = row.kind === "bot" && row.bot.id === bot.id;
          return { ...bot, sectionId, position, ...(moved && wasPinned ? { pinned: false } : {}) };
        }),
        groups: roster.groups?.map((group) => {
          const position = positionByKey.get(`group:${group.id}`);
          if (position === undefined) return group;
          const moved = row.kind === "group" && row.group.id === group.id;
          return { ...group, sectionId, position, ...(moved && wasPinned ? { pinned: false } : {}) };
        }),
      }));
      await enqueue(async () => {
        await api.orderSection(sectionId, { order });
        if (wasPinned) {
          if (row.kind === "bot") await api.updateBot(row.bot.id, { pinned: false });
          else await api.updateGroup(row.group.id, { pinned: false });
        }
      });
    },
    [enqueue, patchRoster],
  );

  /**
   * Une ligne posée À UN EMPLACEMENT de la grille des épinglés : l'ordre
   * complet de la grille est réécrit d'une écriture (`PUT /pinned/order`),
   * la ligne épinglée à son index, sa section inchangée. Reposée à sa place,
   * rien ne part.
   */
  const placePin = useCallback(
    async (row: RosterDragRow, index: number | null, pinnedRows: ReadonlyArray<RosterDragRow>) => {
      const key = rosterRowKey(row);
      const others = pinnedRows.filter((candidate) => rosterRowKey(candidate) !== key);
      const at = index === null ? others.length : Math.min(Math.max(index, 0), others.length);
      const ordered = [...others.slice(0, at), row, ...others.slice(at)];
      if (ordered.length === pinnedRows.length && ordered.every((item, position) => rosterRowKey(item) === rosterRowKey(pinnedRows[position]!))) return;
      const order = ordered.map((item) => ({ kind: item.kind, id: item.kind === "bot" ? item.bot.id : item.group.id }));
      const rank = new Map(order.map((item, position) => [`${item.kind}:${item.id}`, position]));
      patchRoster((roster) => ({
        ...roster,
        bots: roster.bots.map((bot) => {
          const pinPosition = rank.get(`bot:${bot.id}`);
          return pinPosition === undefined ? bot : { ...bot, pinned: true, pinPosition };
        }),
        groups: roster.groups?.map((group) => {
          const pinPosition = rank.get(`group:${group.id}`);
          return pinPosition === undefined ? group : { ...group, pinned: true, pinPosition };
        }),
      }));
      await enqueue(() => api.orderPins({ order }));
    },
    [enqueue, patchRoster],
  );

  /** La ligne déposée sur la zone « Épingler » : épinglée, sa section inchangée. */
  const pinRow = useCallback(
    async (row: RosterDragRow) => {
      patchRoster((roster) => ({
        ...roster,
        bots: row.kind === "bot"
          ? roster.bots.map((bot) => (bot.id === row.bot.id ? { ...bot, pinned: true } : bot))
          : roster.bots,
        groups: row.kind === "group"
          ? roster.groups?.map((group) => (group.id === row.group.id ? { ...group, pinned: true } : group))
          : roster.groups,
      }));
      await enqueue(async () => {
        if (row.kind === "bot") await api.updateBot(row.bot.id, { pinned: true });
        else await api.updateGroup(row.group.id, { pinned: true });
      });
    },
    [enqueue, patchRoster],
  );

  /**
   * Une section neuve, nommée par défaut, avec cette ligne dedans ; l'id
   * revient pour passer l'en-tête en renommage. `null` si rien n'a été créé.
   * La création et le rangement forment une seule écriture de la file : la
   * ligne ne peut partir vers la section qu'une fois son id connu.
   */
  const createSectionWith = useCallback(
    (row: RosterDragRow | null, name?: string): Promise<string | null> =>
      enqueue(async () => {
        const created = await api.createSection(name?.trim() || t("appSidebar.newSectionName"));
        patchRoster((roster) => ({ ...roster, sections: [...roster.sections, created] }));
        if (row) await writeMove(row, patchMove(row, created.id));
        return created.id;
      }),
    [enqueue, patchMove, patchRoster, t, writeMove],
  );

  /**
   * Le dépôt d'une ligne : la zone « Épingler », ou une section (la sienne
   * pour réordonner, une autre pour y ranger, « Non assignés » compris).
   * `rowsOf` donne les lignes affichées de la section, dans l'ordre affiché.
   */
  const dropRow = useCallback(
    (
      row: RosterDragRow,
      target: string,
      slot: RosterDropSlot | null,
      rowsOf: (sectionId: string) => ReadonlyArray<RosterDragRow>,
    ): Promise<void> => {
      const index = slot?.sectionId === target ? slot.index : null;
      if (target === PINNED_DROP_ID) return placePin(row, index, rowsOf(PINNED_DROP_ID));
      return placeRow(row, target, index, rowsOf(target));
    },
    [placePin, placeRow],
  );

  /**
   * Une section glissée avant l'éditable d'index `index` (`=== length` : en
   * dernier) : l'ordre complet des éditables part d'une écriture. « Non
   * assignés », la section par défaut, garde sa place.
   */
  const reorderSection = useCallback(
    async (sectionId: string, index: number, editableIds: ReadonlyArray<string>) => {
      const from = editableIds.indexOf(sectionId);
      if (from === -1) return;
      const others = editableIds.filter((id) => id !== sectionId);
      const at = Math.min(Math.max(index > from ? index - 1 : index, 0), others.length);
      const order = [...others.slice(0, at), sectionId, ...others.slice(at)];
      if (order.every((id, position) => id === editableIds[position])) return;
      patchRoster((roster) => {
        const base = Math.min(...roster.sections.filter((section) => !editableIds.includes(section.id)).map((section) => section.position));
        const rank = new Map(order.map((id, position) => [id, base + 1 + position]));
        return {
          ...roster,
          sections: roster.sections.map((section) => {
            const position = rank.get(section.id);
            return position === undefined ? section : { ...section, position };
          }),
        };
      });
      await enqueue(() => api.orderSections({ order }));
    },
    [enqueue, patchRoster],
  );

  const renameSection = useCallback(
    async (sectionId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      patchRoster((roster) => ({
        ...roster,
        sections: roster.sections.map((section) => (section.id === sectionId ? { ...section, name: trimmed } : section)),
      }));
      await enqueue(() => api.updateSection(sectionId, { name: trimmed }));
    },
    [enqueue, patchRoster],
  );

  const setCollapsed = useCallback(
    async (sectionId: string, collapsed: boolean) => {
      patchRoster((roster) => ({
        ...roster,
        sections: roster.sections.map((section) => (section.id === sectionId ? { ...section, collapsed } : section)),
      }));
      await enqueue(() => api.updateSection(sectionId, { collapsed }), { refresh: false });
    },
    [enqueue, patchRoster],
  );

  const moveSection = useCallback(
    async (sectionId: string, position: number) => {
      await enqueue(() => api.updateSection(sectionId, { position }));
    },
    [enqueue],
  );

  const deleteSection = useCallback(
    async (sectionId: string) => {
      await enqueue(() => api.deleteSection(sectionId));
    },
    [enqueue],
  );

  return { moveRow, placeRow, placePin, pinRow, createSectionWith, dropRow, reorderSection, renameSection, setCollapsed, moveSection, deleteSection };
}
