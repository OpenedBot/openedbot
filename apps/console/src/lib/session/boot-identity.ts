/**
 * The label of the organization head (top left: the operator handle in a
 * personal account, the organization name otherwise), remembered so that a
 * refresh paints it at once instead of a pulsing bar: in the HTML silhouette
 * of `index.html` (it reads the same key, keep the two in step), in the frame
 * skeleton and in the head itself until `/api/auth/me` answers.
 *
 * The face beside it is the fixed organization artwork, never data. The label
 * is shown only to the user it was recorded for, and sign out or a lost
 * session clears it with the persisted queries (`query-persister.ts`).
 */
export const BOOT_IDENTITY_KEY = "openedbot:boot-identity";

const MAX_LABEL = 64;

type BootIdentity = { userId: string; label: string };

export function readBootIdentityLabel(userId: string | undefined): string | null {
  if (!userId) return null;
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(BOOT_IDENTITY_KEY) ?? "null") as Partial<BootIdentity> | null;
    if (!parsed || parsed.userId !== userId || typeof parsed.label !== "string" || !parsed.label) return null;
    return parsed.label.slice(0, MAX_LABEL);
  } catch {
    return null;
  }
}

export function rememberBootIdentity(userId: string | undefined, label: string): void {
  if (!userId || !label) return;
  try {
    const next = JSON.stringify({ userId, label: label.slice(0, MAX_LABEL) } satisfies BootIdentity);
    if (globalThis.localStorage?.getItem(BOOT_IDENTITY_KEY) !== next) globalThis.localStorage?.setItem(BOOT_IDENTITY_KEY, next);
  } catch {
    // Private mode or quota: the next load pulses the label, as before.
  }
}

export function clearBootIdentity(): void {
  try {
    globalThis.localStorage?.removeItem(BOOT_IDENTITY_KEY);
  } catch {
    // Nothing to clear.
  }
}
