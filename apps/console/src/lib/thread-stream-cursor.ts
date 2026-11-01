/**
 * Le curseur auquel un snapshot attache le flux : celui de l'ORGANISATION
 * quand l'API le donne, sinon celui du fil (API antérieure : le serveur
 * rejouera alors davantage, jamais moins).
 */
export function streamStartCursor(snapshot: { cursor: number; organizationCursor?: number } | undefined): number | undefined {
  if (!snapshot) return undefined;
  return typeof snapshot.organizationCursor === "number" && Number.isFinite(snapshot.organizationCursor)
    ? snapshot.organizationCursor
    : snapshot.cursor;
}

/**
 * Curseur auquel attacher le flux SSE d'un fil.
 *
 * L'écran de conversation n'est pas remonté quand on change de bot : le
 * `useRef` du curseur survit. Le reprendre tel quel, ou le `Math.max` avec
 * l'ancien fil, accroche le nouveau trop loin (deltas sautés) et fait passer
 * le snapshot neuf pour un snapshot en retard.
 */
export function cursorForOpenThread(args: {
  openThreadId: string | undefined;
  nextThreadId: string | undefined;
  currentCursor: number;
  snapshotCursor: number | undefined;
}): number {
  const { openThreadId, nextThreadId, currentCursor, snapshotCursor } = args;
  if (!nextThreadId) return 0;
  if (openThreadId !== nextThreadId) return snapshotCursor ?? 0;
  return Math.max(currentCursor, snapshotCursor ?? 0);
}
