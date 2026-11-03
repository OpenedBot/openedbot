/**
 * A snapshot request can start before an SSE delta and resolve after it. The
 * server cursor is the ordering authority: an older HTTP response must never
 * replace the projection already advanced by the stream.
 */
export function keepNewestThreadSnapshot<T extends { id: string; cursor: number }>(
  current: T | undefined,
  incoming: T,
): T {
  return current?.id === incoming.id && current.cursor > incoming.cursor ? current : incoming;
}

/** Only the snapshot belonging to the currently open query may move its cursor. */
export function isCurrentThreadSnapshot<T extends { id: string }>(
  snapshot: T | undefined,
  threadId: string,
): snapshot is T {
  return snapshot?.id === threadId;
}

/** Un restart SSE/session n'est pas un changement de fil si son cache est déjà affichable. */
export function shouldWaitForThreadSnapshot<T extends { id: string }>(
  snapshot: T | undefined,
  threadId: string,
): boolean {
  return !isCurrentThreadSnapshot(snapshot, threadId);
}

/**
 * Read a thread without allowing a late HTTP response to erase SSE state.
 *
 * When the first response is already stale, a second read starts after the
 * observed delta. Product events are published after their transaction is
 * committed, so that read also recovers the persisted message/approval/tool
 * attachment which is not projected by every SSE event.
 */
export async function readNewestThreadSnapshot<T extends { id: string; cursor: number }>(
  read: () => Promise<T>,
  current: () => T | undefined,
): Promise<T> {
  const incoming = await read();
  if (keepNewestThreadSnapshot(current(), incoming) === incoming) return incoming;

  const caughtUp = await read();
  return keepNewestThreadSnapshot(current(), caughtUp);
}
