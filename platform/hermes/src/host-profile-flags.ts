/**
 * Les drapeaux d'un profil hôte, sans dépendance vers `contracts.ts` (qui les
 * réexporte) : nom et état d'un skill ou d'un toolset, et le serveur MCP.
 */

export type HermesMcpAuth = "none" | "header" | "oauth";

export type HermesProfileNamedFlag = {
  name: string;
  enabled: boolean;
};

/**
 * Un serveur MCP d'un profil nommé. Porter l'entrée ne prouve rien : un
 * profil naît d'une copie de la configuration racine, et la bascule MCP d'un
 * profil y recopie l'entrée racine, tous deux sans jeton.
 *
 * `auth`, `endpoint` et `oauthTokenPresent` viennent ensemble d'un hôte qui
 * décrit l'entrée ; un hôte plus ancien (ou une configuration en liste) ne
 * les envoie pas, et le serveur se lit alors comme avant : on ne sait pas.
 */
export type HermesProfileMcpServer = {
  name: string;
  enabled: boolean;
  /** L'URL de l'entrée, `null` sans URL (serveur stdio). */
  endpoint?: string | null;
  auth?: HermesMcpAuth;
  /**
   * Pour un serveur `oauth` : le fichier de jeton du PROFIL est-il sur le
   * disque (jamais son contenu) ? `null` quand l'hôte n'a pas pu le vérifier,
   * ou pour un autre mode d'authentification.
   */
  oauthTokenPresent?: boolean | null;
};
