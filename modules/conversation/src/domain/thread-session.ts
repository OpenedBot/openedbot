/**
 * La session Hermes d'un fil, par génération (0163).
 *
 * Hermes fige le prompt système et les outils d'une session à son premier
 * tour : une capacité (toolset, skill, serveur MCP) changée ensuite n'y entre
 * jamais. Le fil passe alors à une génération suivante, c'est-à-dire à une
 * session neuve ; openedbot renvoie l'historique à chaque tour, rien ne se
 * perd côté modèle. La génération 0 garde la clé d'origine.
 */
export function threadSessionKey(threadSessionId: string, generation: number): string {
  return generation > 0 ? `${threadSessionId}:gen${generation}` : threadSessionId;
}

/**
 * Toutes les clés qu'un fil a pu ouvrir, de la génération 0 à la courante :
 * l'effacement d'un bot doit les retirer toutes de l'hôte. Une génération
 * jamais ouverte (run échoué avant Hermes) répond 404, ce que
 * `deleteSession` tient pour un succès.
 */
export function threadSessionKeys(threadSessionId: string, generation: number): string[] {
  const last = Number.isInteger(generation) && generation > 0 ? generation : 0;
  return Array.from({ length: last + 1 }, (_, index) => threadSessionKey(threadSessionId, index));
}

export type ThreadSessionState = {
  generation: number;
  /** Premier run servi par la génération courante ; `null` : pas encore, ou fil d'avant 0163. */
  openedAt: Date | null;
  threadCreatedAt: Date;
};

/**
 * La génération courante est-elle périmée ? Oui quand une capacité de ce
 * runtime (sa racine, ou le profil du bot) a changé APRÈS l'ouverture de sa
 * session. Un fil d'avant 0163 n'a pas d'instant d'ouverture : sa création
 * en tient lieu, ce qui tranche du côté sûr (une rotation de trop ne coûte
 * qu'un défaut de cache, une de moins laisse le bot sur ses anciens outils).
 */
export function threadSessionStale(state: ThreadSessionState, capabilitiesChangedAt: Date | null): boolean {
  if (!capabilitiesChangedAt) return false;
  const opened = state.openedAt ?? state.threadCreatedAt;
  return capabilitiesChangedAt.getTime() > opened.getTime();
}

/** Le dernier changement qui concerne ce bot : la racine, et son profil nommé s'il en a un. */
export function latestCapabilityChange(rootChangedAt: Date | null, profileChangedAt: Date | null): Date | null {
  if (!rootChangedAt) return profileChangedAt;
  if (!profileChangedAt) return rootChangedAt;
  return rootChangedAt.getTime() >= profileChangedAt.getTime() ? rootChangedAt : profileChangedAt;
}
