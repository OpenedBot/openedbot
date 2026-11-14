import { useRosterDrag } from "./roster-drag";

/**
 * The insertion stroke: where the picked-up row will land. Rendered above
 * the row of index `index`; `index === rows.length` means the end of the
 * section (rendered after the last row).
 */
export function RosterInsertionLine({ sectionId, index, quiet = false }: { sectionId: string; index: number; quiet?: boolean }) {
  const { dragging } = useRosterDrag();
  const slot = dragging?.slot;
  // `quiet`: the slot is the picked-up row's current place:
  // dropping it there would change nothing, the stroke would only say a false move.
  if (quiet || !slot || slot.sectionId !== sectionId || slot.index !== index) return null;
  return <span aria-hidden data-roster-insertion="" className="pointer-events-none absolute inset-x-2 -top-0.5 z-10 h-0.5 rounded-full bg-primary" />;
}
