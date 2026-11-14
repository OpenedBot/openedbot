import { useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { RosterDto } from "@openedbot/contracts-api";
import { toast } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { PINNED_DROP_ID, rosterRowKey, type RosterDragRow, type RosterDropSlot } from "./roster-drag";

/**
 * The roster writes' queue, one per request client: every
 * bar and every menu that files rows shares it.
 *
 * A drop shows at once (optimistic cache update) and its
 * write leaves behind it, blocking nothing: one can chain drops
 * without waiting for the server. Writes leave one by one, in the order
 * of the gestures: two `PUT /order` in flight could arrive out of order
 * and leave the first gesture's order. The roster is reread only once the
 * queue is empty: a reread between two writes would bring back an intermediate
 * order and the row would jump backward before coming back.
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

/** The number of roster writes still queued: for the tests. */
export function pendingRosterWrites(queryClient: QueryClient): number {
  return writeQueues.get(queryClient)?.pending ?? 0;
}

/**
 * The sidebar's section writes, with their optimistic
 * update of the cached roster: a dropped row changes place
 * at once, the server confirms behind. On failure the roster is reread
 * as it is once the queue is empty: the true state comes back, and the toast says
 * why.
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
      // A read in flight, started before this gesture, would overwrite the optimistic state
      // on its return. Cancelled, it comes back to the state written below (a
      // `setQueryData` during a fetch becomes its fallback state).
      void queryClient.cancelQueries({ queryKey: queryKeys.roster });
      queryClient.setQueryData<RosterDto>(queryKeys.roster, (roster) => (roster ? patch(roster) : roster));
    },
    [queryClient],
  );

  /**
   * Puts `write` in the queue. `refresh: false`: a write whose optimistic
   * state is enough (a section's collapse) does not reread the roster.
   * Resolves `null` if the write failed; never rejects.
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

  /** The optimistic state of a row that joins a section (and leaves the pins). */
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
   * A row dropped on a section goes there, and leaves the pins if it
   * was there: pins live above the sections, a row cannot
   * be in both places.
   */
  const moveRow = useCallback(
    async (row: RosterDragRow, sectionId: string) => {
      const patch = patchMove(row, sectionId);
      await enqueue(() => writeMove(row, patch));
    },
    [enqueue, patchMove, writeMove],
  );

  /**
   * A row placed AT ONE PLACE in a section: the section's complete order
   * is rewritten in one write (`PUT /order`): bots and groups
   * interleaved, the row moved to its index, the others tightened. A
   * pinned one that joins a section stops being pinned. Put back in its
   * place, nothing leaves.
   */
  const placeRow = useCallback(
    async (row: RosterDragRow, sectionId: string, index: number | null, sectionRows: ReadonlyArray<RosterDragRow>) => {
      const key = rosterRowKey(row);
      const from = sectionRows.findIndex((candidate) => rosterRowKey(candidate) === key);
      const others = sectionRows.filter((candidate) => rosterRowKey(candidate) !== key);
      // The slot counts the displayed rows, the carried row included;
      // `others` no longer has it: below its place, everything shifts back one rank. Without this
      // offset, moving a row down one step placed it one step too low.
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
   * A row placed AT ONE SLOT of the pins grid: the grid's complete
   * order is rewritten in one write (`PUT /pinned/order`),
   * the row pinned at its index, its section unchanged. Put back in its place,
   * nothing leaves.
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

  /** The row dropped on the « Épingler » zone: pinned, its section unchanged. */
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
   * A new section, named by default, with this row in it; the id
   * comes back so the header can switch to renaming. `null` if nothing was created.
   * Creation and filing form a single write of the queue: the
   * row can leave for the section only once its id is known.
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
   * A row's drop: the « Épingler » zone, or a section (its own
   * to reorder, another to file it there, « Non assignés » included).
   * `rowsOf` gives the section's displayed rows, in the displayed order.
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
   * A section dragged before the editable one of index `index` (`=== length`:
   * last): the complete order of the editable ones leaves in one write. « Non
   * assignés », the default section, keeps its place.
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
