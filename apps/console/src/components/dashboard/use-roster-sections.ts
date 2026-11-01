import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RosterDto } from "@openedbot/contracts-api";
import { toast } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { PINNED_DROP_ID, type RosterDragRow, type RosterDropSlot } from "./roster-drag";

/**
 * Les écritures de sections de la barre latérale, avec leur mise à jour
 * optimiste du roster en cache : une ligne déposée change de section à
 * l'instant, le serveur confirme derrière (`invalidateQueries`). En cas
 * d'échec le roster est relu tel quel : l'état vrai revient, et le toast
 * dit pourquoi.
 */
export function useRosterSections() {
  const { t } = useT();
  const queryClient = useQueryClient();

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
    [queryClient],
  );
  const fail = useCallback(
    (error: unknown) => {
      toast.error(error instanceof ApiError ? error.message : t("botContextMenu.actionFailed"));
      void invalidate();
    },
    [invalidate, t],
  );
  const patchRoster = useCallback(
    (patch: (roster: RosterDto) => RosterDto) => {
      queryClient.setQueryData<RosterDto>(queryKeys.roster, (roster) => (roster ? patch(roster) : roster));
    },
    [queryClient],
  );

  /**
   * Une ligne déposée sur une section y va, et quitte les épinglés si elle
   * y était : les épinglés vivent au-dessus des sections, une ligne ne peut
   * pas être aux deux endroits.
   */
  const moveRow = useCallback(
    async (row: RosterDragRow, sectionId: string) => {
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
      try {
        if (row.kind === "bot") await api.updateBot(row.bot.id, patch);
        else await api.updateGroup(row.group.id, patch);
        await invalidate();
      } catch (error) {
        fail(error);
      }
    },
    [fail, invalidate, patchRoster],
  );

  /**
   * Une ligne posée À UN ENDROIT d'une section : l'ordre complet de la
   * section est réécrit en une écriture (`PUT /order`) : bots et salons
   * entrelacés, la ligne déplacée à son index, les autres resserrées. Une
   * épinglée qui rejoint une section cesse d'être épinglée.
   */
  const placeRow = useCallback(
    async (row: RosterDragRow, sectionId: string, index: number | null, sectionRows: ReadonlyArray<RosterDragRow>) => {
      const same = (a: RosterDragRow, b: RosterDragRow) =>
        a.kind === b.kind && (a.kind === "bot" ? a.bot.id : a.group.id) === (b.kind === "bot" ? b.bot.id : b.group.id);
      const others = sectionRows.filter((candidate) => !same(candidate, row));
      const at = index === null ? others.length : Math.min(index, others.length);
      const ordered = [...others.slice(0, at), row, ...others.slice(at)];
      const order = ordered.map((item) => ({ kind: item.kind, id: item.kind === "bot" ? item.bot.id : item.group.id }));
      const positionByKey = new Map(order.map((item, position) => [`${item.kind}:${item.id}`, position]));
      const wasPinned = row.kind === "bot" ? row.bot.pinned : row.group.pinned === true;
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
      try {
        await api.orderSection(sectionId, { order });
        if (wasPinned) {
          if (row.kind === "bot") await api.updateBot(row.bot.id, { pinned: false });
          else await api.updateGroup(row.group.id, { pinned: false });
        }
        await invalidate();
      } catch (error) {
        fail(error);
      }
    },
    [fail, invalidate, patchRoster],
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
      try {
        if (row.kind === "bot") await api.updateBot(row.bot.id, { pinned: true });
        else await api.updateGroup(row.group.id, { pinned: true });
        await invalidate();
      } catch (error) {
        fail(error);
      }
    },
    [fail, invalidate, patchRoster],
  );

  /**
   * Une section neuve, nommée par défaut, avec cette ligne dedans ; l'id
   * revient pour passer l'en-tête en renommage. `null` si rien n'a été créé.
   */
  const createSectionWith = useCallback(
    async (row: RosterDragRow | null, name?: string): Promise<string | null> => {
      try {
        const created = await api.createSection(name?.trim() || t("appSidebar.newSectionName"));
        patchRoster((roster) => ({ ...roster, sections: [...roster.sections, created] }));
        if (row) await moveRow(row, created.id);
        else await invalidate();
        return created.id;
      } catch (error) {
        fail(error);
        return null;
      }
    },
    [fail, invalidate, moveRow, patchRoster, t],
  );

  /**
   * Le dépôt d'une ligne : la zone « Épingler », ou une section (la sienne
   * pour réordonner, une autre pour y ranger, « Non assigné » compris).
   * `rowsOf` donne les lignes affichées de la section, dans l'ordre affiché.
   */
  const dropRow = useCallback(
    (
      row: RosterDragRow,
      target: string,
      slot: RosterDropSlot | null,
      rowsOf: (sectionId: string) => ReadonlyArray<RosterDragRow>,
    ): Promise<void> => {
      if (target === PINNED_DROP_ID) return pinRow(row);
      return placeRow(row, target, slot?.sectionId === target ? slot.index : null, rowsOf(target));
    },
    [pinRow, placeRow],
  );

  const renameSection = useCallback(
    async (sectionId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      patchRoster((roster) => ({
        ...roster,
        sections: roster.sections.map((section) => (section.id === sectionId ? { ...section, name: trimmed } : section)),
      }));
      try {
        await api.updateSection(sectionId, { name: trimmed });
        await invalidate();
      } catch (error) {
        fail(error);
      }
    },
    [fail, invalidate, patchRoster],
  );

  const setCollapsed = useCallback(
    async (sectionId: string, collapsed: boolean) => {
      patchRoster((roster) => ({
        ...roster,
        sections: roster.sections.map((section) => (section.id === sectionId ? { ...section, collapsed } : section)),
      }));
      try {
        await api.updateSection(sectionId, { collapsed });
      } catch (error) {
        fail(error);
      }
    },
    [fail, patchRoster],
  );

  const moveSection = useCallback(
    async (sectionId: string, position: number) => {
      try {
        await api.updateSection(sectionId, { position });
        await invalidate();
      } catch (error) {
        fail(error);
      }
    },
    [fail, invalidate],
  );

  const deleteSection = useCallback(
    async (sectionId: string) => {
      try {
        await api.deleteSection(sectionId);
        await invalidate();
      } catch (error) {
        fail(error);
      }
    },
    [fail, invalidate],
  );

  return { moveRow, placeRow, pinRow, createSectionWith, dropRow, renameSection, setCollapsed, moveSection, deleteSection };
}
