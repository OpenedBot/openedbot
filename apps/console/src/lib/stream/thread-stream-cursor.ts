/**
 * The cursor at which a snapshot attaches the stream: the ORGANIZATION's
 * when the API gives it, otherwise the thread's (an earlier API: the server
 * will then replay more, never less).
 */
export function streamStartCursor(snapshot: { cursor: number; organizationCursor?: number } | undefined): number | undefined {
  if (!snapshot) return undefined;
  return typeof snapshot.organizationCursor === "number" && Number.isFinite(snapshot.organizationCursor)
    ? snapshot.organizationCursor
    : snapshot.cursor;
}

/**
 * Cursor at which to attach a thread's SSE stream.
 *
 * The conversation screen is not remounted when the bot changes: the
 * cursor's `useRef` survives. Taking it as-is, or `Math.max` with
 * the previous thread, hooks the new one too far ahead (skipped deltas) and makes
 * the fresh snapshot look like a late snapshot.
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
