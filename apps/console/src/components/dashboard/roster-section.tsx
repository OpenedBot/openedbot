import { useRosterDrag } from "./roster-drag";

/**
 * Le trait d'insertion : là où la ligne prise se posera. Rendu au-dessus de
 * la ligne d'index `index` ; `index === rows.length` désigne la fin de la
 * section (rendu après la dernière ligne).
 */
export function RosterInsertionLine({ sectionId, index, quiet = false }: { sectionId: string; index: number; quiet?: boolean }) {
  const { dragging } = useRosterDrag();
  const slot = dragging?.slot;
  // `quiet` : le créneau est la place actuelle de la ligne prise : la
  // déposer là ne changerait rien, le trait ne dirait qu'un faux mouvement.
  if (quiet || !slot || slot.sectionId !== sectionId || slot.index !== index) return null;
  return <span aria-hidden data-roster-insertion="" className="pointer-events-none absolute inset-x-2 -top-0.5 z-10 h-0.5 rounded-full bg-primary" />;
}
