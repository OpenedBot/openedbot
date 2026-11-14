import { api } from "../api";
import { readCloudSession, saveCloudSession } from "../session/cloud-session";
import { NATIVE_SESSION_MARK } from "../platform";

/**
 * The compact route (DEV-139): the thread and composer of ONE bot, without a
 * sidebar, without settings, without onboarding. The desktop app's notch
 * opens it on a thread; it stays openable in a browser with the session
 * cookie.
 */
export const COMPACT_PATH = "/compact";

const LAST_BOT_KEY = "openedbot:compact-last-bot";

export function isCompactPath(pathname: string): boolean {
  return pathname === COMPACT_PATH || pathname.startsWith(`${COMPACT_PATH}/`);
}

/** The last bot opened in the compact window: `/compact` reopens it. */
export function readCompactLastBot(): string | null {
  try {
    return globalThis.window?.localStorage.getItem(LAST_BOT_KEY) ?? null;
  } catch {
    return null;
  }
}

export function rememberCompactLastBot(botId: string): void {
  try {
    globalThis.window?.localStorage.setItem(LAST_BOT_KEY, botId);
  } catch {
    /* Storage unavailable: `/compact` will fall back to the first bot. */
  }
}

/**
 * Sets the window's cloud session from the native bridge: `/api/auth/me`
 * with the bearer gives the organization and the person, which `cloud-session`
 * otherwise holds from the cookie set at login. `false` when the bearer is refused:
 * the shell must reopen its sign-in page.
 */
export async function primeNativeSession(): Promise<boolean> {
  const me = await api.authMe().catch(() => null);
  if (!me) return false;
  const current = readCloudSession();
  const organizationId = me.organization.id || null;
  if (current?.csrfToken === NATIVE_SESSION_MARK && current.userId === me.user.id && current.organizationId === organizationId) return true;
  saveCloudSession({ organizationId, csrfToken: NATIVE_SESSION_MARK, userId: me.user.id });
  return true;
}
