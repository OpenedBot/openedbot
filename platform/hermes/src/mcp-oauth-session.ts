import type { HermesMcpOauthStatus } from "./contracts";

/**
 * Une autorisation OAuth d'un serveur MCP, jouée sur l'hôte avec openedbot pour
 * jambe navigateur. `connected` seulement quand l'hôte a relu un jeton sur son
 * disque et listé les outils avec lui, jamais sur le seul callback.
 */
export type HermesMcpOauthSession = {
  sessionId: string;
  server: string;
  /**
   * Le profil dont le home reçoit le jeton : un profil nommé, `null` pour la
   * racine du runtime, `undefined` quand l'hôte ne le dit pas (edge-setup
   * plus ancien) : la session peut alors appartenir à n'importe quel bot.
   */
  profile?: string | null;
  status: HermesMcpOauthStatus;
  /**
   * Le retour du fournisseur a atteint l'hôte, qui termine l'autorisation :
   * il refuse alors de l'annuler. `undefined` sur un hôte plus ancien, qui ne
   * le dit pas (et annule toujours).
   */
  callbackReceived?: boolean;
  authorizationUrl: string | null;
  error: string | null;
  errorCode: string | null;
  discoveredTools: string[];
  expiresAt: string;
};
