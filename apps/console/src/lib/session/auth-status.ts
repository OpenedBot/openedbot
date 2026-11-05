/**
 * Ce que la fenêtre EST pour le cloud API, et si l'application la laisse entrer.
 *
 * Deux lectures, une décision (`isAppAuthenticated`) :
 * - le cloud API offre-t-il le SSO (`GET /api/auth/providers`, public) ;
 * - par quoi cette fenêtre est-elle authentifiée (`GET /api/auth/me`) : une
 *   session cloud, ou rien (401).
 *
 * La règle cloud-only est stricte : l'application exige toujours une session
 * utilisateur, quel que soit le client ou le fournisseur d'identité configuré.
 *
 * `unknown` : le cloud API n'a pas répondu (pas encore là, coupé). On laisse
 * passer : les écrans savent déjà montrer « cloud API injoignable », et un garde
 * qui bloquerait sur une panne cacherait la panne. Jamais mis en cache.
 *
 * Mis en cache jusqu'à ce que le jeton change ou qu'un 401 tombe
 * (la session cloud prévient) : le garde de route (`route-tree.tsx`)
 * l'appelle à chaque navigation et ne doit pas coûter une requête à chaque fois.
 */
import type { AuthUserDto } from "@openedbot/contracts-api";
import { api, isUnauthorized, queryKeys } from "../api";
import { subscribeCloudSession } from "./cloud-session";
import { queryClient } from "../query-client";

export type AuthStatus = {
  kind: "session" | "none" | "unknown";
  ssoEnabled: boolean;
  user: AuthUserDto | null;
  sessionId: string | null;
  /** Pour `none` : le code du 401 (`UNAUTHORIZED`, `SESSION_EXPIRED`, `SESSION_REVOKED`) : `/login` nomme la raison. */
  reason: string | null;
  /**
   * Le compte a été créé par l'équipe avec un mot de passe temporaire, et ne
   * l'a pas encore remplacé (`users.must_change_password`). Le garde de route
   * n'ouvre alors que l'écran de sécurité : « temporaire » n'est un fait que si
   * l'application le tient. Toujours `false` hors session.
   */
  mustChangePassword: boolean;
};

export const UNKNOWN_AUTH_STATUS: AuthStatus = { kind: "unknown", ssoEnabled: false, user: null, sessionId: null, reason: null, mustChangePassword: false };

export function isAppAuthenticated(status: AuthStatus): boolean {
  if (status.kind === "session") return true;
  return false;
}

let cached: Promise<AuthStatus> | null = null;

/** Même mapping que `api.authStatus`, en semence du cache React Query. */
async function loadAuthStatusFromQuery(): Promise<AuthStatus> {
  try {
    const me = await queryClient.fetchQuery({
      queryKey: queryKeys.authMe,
      queryFn: api.authMe,
      staleTime: 10_000,
    });
    if (me.kind !== "session") {
      return { kind: "none", ssoEnabled: true, user: null, sessionId: null, reason: "AUTH_REQUIRED", mustChangePassword: false };
    }
    return {
      kind: "session",
      ssoEnabled: true,
      user: me.user,
      sessionId: me.sessionId,
      reason: null,
      mustChangePassword: me.mustChangePassword === true,
    };
  } catch (error) {
    if (isUnauthorized(error)) {
      return { kind: "none", ssoEnabled: true, user: null, sessionId: null, reason: error.code ?? null, mustChangePassword: false };
    }
    throw error;
  }
}

export function ensureAuthStatus(load: () => Promise<AuthStatus> = loadAuthStatusFromQuery): Promise<AuthStatus> {
  if (!cached) {
    const promise = load().catch(() => UNKNOWN_AUTH_STATUS);
    cached = promise;
    // Une panne ne se met pas en cache : la navigation suivante redemande.
    void promise.then((status) => {
      if (status.kind === "unknown" && cached === promise) cached = null;
    });
  }
  return cached;
}

export function resetAuthStatus() {
  cached = null;
}

subscribeCloudSession(resetAuthStatus);

// Un jeton qui change ou un 401 rend la réponse précédente caduque.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === "openedbot:cloud-session") resetAuthStatus();
  });
}
