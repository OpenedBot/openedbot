/** Identifiant public d'une voix fournisseur, jamais une clé ni un secret. */
export const BOT_VOICE_ID_MAX_CHARS = 512;

export class BotVoiceIdError extends Error {
  readonly code = "BOT_VOICE_ID_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "BotVoiceIdError";
  }
}

/**
 * Normalise le choix de voix persisté sur un bot.
 *
 * Une valeur vide efface le choix explicite et laisse le client reprendre sa
 * voix par défaut. Le dépassement est refusé : tronquer un identifiant peut
 * sélectionner une autre ressource fournisseur ou rendre la panne opaque.
 */
export function normalizeBotVoiceId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new BotVoiceIdError("L’identifiant de voix doit être une chaîne ou null.");
  }
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > BOT_VOICE_ID_MAX_CHARS) {
    throw new BotVoiceIdError(`L’identifiant de voix dépasse ${BOT_VOICE_ID_MAX_CHARS} caractères.`);
  }
  return normalized;
}
