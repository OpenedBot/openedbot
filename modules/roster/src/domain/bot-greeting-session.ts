/**
 * La session du run d'accueil quand il part sur le profil par défaut, avant
 * que le profil nommé du bot existe (DEV-OHB-244). Elle vit donc sur le
 * profil par défaut, pas sur celui du bot : le nettoyage hôte l'y efface.
 */
export function greetingSessionKey(threadSessionId: string): string {
  return `${threadSessionId}:greeting`;
}

export function isGreetingSessionKey(sessionId: string): boolean {
  return sessionId.endsWith(":greeting");
}
