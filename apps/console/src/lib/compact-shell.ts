import { api } from "./api";
import { readCloudSession, saveCloudSession } from "./cloud-session";
import { NATIVE_SESSION_MARK } from "./native-bridge";

/**
 * La route compacte (DEV-139) : le fil et le composer d'UN bot, sans barre
 * latérale, sans réglages, sans onboarding. C'est ce que la coque native
 * `openedbot-desktop` charge dans sa fenêtre ; elle reste ouvrable dans un
 * navigateur avec le cookie de session, pour la recette sans Electron.
 */
export const COMPACT_PATH = "/compact";

const LAST_BOT_KEY = "ohb:compact-last-bot";

export function isCompactPath(pathname: string): boolean {
  return pathname === COMPACT_PATH || pathname.startsWith(`${COMPACT_PATH}/`);
}

/** Le dernier bot ouvert dans la fenêtre compacte : `/compact` le rouvre. */
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
    /* Stockage indisponible : `/compact` retombera sur le premier bot. */
  }
}

/**
 * Pose la session cloud de la fenêtre depuis le pont natif : `/api/auth/me`
 * avec le bearer donne l'organisation et la personne, que `cloud-session`
 * tient sinon du cookie posé au login. `false` quand le bearer est refusé :
 * la coque doit rouvrir sa page de connexion.
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
