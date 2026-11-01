/**
 * Whether this browser last saw the app frame's access guards pass for the
 * signed-in user (session, organization, completed onboarding).
 *
 * A refresh used to paint the whole app as a skeleton until those three reads
 * answered, although the roster and the threads already sit in IndexedDB for
 * exactly that moment (`query-persister.ts`). With this hint the frame opens
 * at once on the cached state and the guards run behind it; a guard that
 * fails still redirects, and clears the hint so the next refresh waits again.
 *
 * It names a user, never grants anything: every read and write is still
 * checked by the API, and the cached data is that user's own. Sign out and a
 * lost or replaced session clear it with the persisted queries.
 */
const STORAGE_KEY = "ohb:app-access:v1";

export function markAppAccess(userId: string | undefined): void {
  if (!userId) return;
  try {
    globalThis.window?.localStorage.setItem(STORAGE_KEY, userId);
  } catch {
    // Storage unavailable: the next refresh waits for the guards, as before.
  }
}

export function hasAppAccessHint(userId: string | undefined): boolean {
  if (!userId) return false;
  try {
    return globalThis.window?.localStorage.getItem(STORAGE_KEY) === userId;
  } catch {
    return false;
  }
}

export function clearAppAccessHint(): void {
  try {
    globalThis.window?.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
