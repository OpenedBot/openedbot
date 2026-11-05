/**
 * Phrases written in `last_health_error` when openedbot itself dropped the link
 * (deploy, gateway stop). The stored sentence has no clock; the screen adds
 * the last sign of life. Older rows keep the previous wording, matched here
 * so a host that never reconnects still reads the dated sentence.
 */
const OPENEDBOT_RESTART_ERRORS = new Set([
  "L’instance openedbot qui tenait le lien s’est arrêtée.",
  "L’instance openedbot qui tenait le lien s’est arrêtée avant la fin du drainage.",
  "openedbot a redémarré ; l’hôte ne s’est pas reconnecté depuis.",
  "openedbot a redémarré avant la fin du drainage ; l’hôte ne s’est pas reconnecté depuis.",
  // Rows written before the rename to openedbot (`last_health_error` is stored text).
  "L’instance openedbot qui tenait le lien s’est arrêtée.",
  "L’instance openedbot qui tenait le lien s’est arrêtée avant la fin du drainage.",
  "openedbot a redémarré ; l’hôte ne s’est pas reconnecté depuis.",
  "openedbot a redémarré avant la fin du drainage ; l’hôte ne s’est pas reconnecté depuis.",
]);

export function linkHealthErrorText(
  error: string | null | undefined,
  lastSeenAt: string | null | undefined,
  restarted: (date: string) => string,
): string | null {
  const text = error?.trim();
  if (!text) return null;
  if (lastSeenAt && OPENEDBOT_RESTART_ERRORS.has(text)) return restarted(lastSeenAt);
  return text;
}
