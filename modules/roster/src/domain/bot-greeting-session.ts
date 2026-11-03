/**
 * La session du run d'accueil des bots créés quand il partait sur le profil
 * par défaut, avant que le profil nommé du bot existe (DEV-OHB-244 ; l'accueil
 * attend maintenant ce profil). Ces sessions vivent sur le profil par défaut,
 * pas sur celui du bot : le nettoyage hôte les y efface encore.
 */
export function greetingSessionKey(threadSessionId: string): string {
  return `${threadSessionId}:greeting`;
}

export function isGreetingSessionKey(sessionId: string): boolean {
  return sessionId.endsWith(":greeting");
}
