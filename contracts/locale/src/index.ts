/**
 * Contrat de locale : les deux langues du produit, la langue servie par
 * défaut, la langue de repli du dictionnaire et leur normalisation. Pur, sans
 * dictionnaire : le serveur l'importe sans charger les messages.
 */

export type Locale = "fr" | "en";

/**
 * La langue servie à qui n'a exprimé aucune préférence : l'anglais.
 *
 * Le français reste la langue de RÉFÉRENCE du dictionnaire (`messages.fr.ts`
 * est le fichier dont les clés font foi, et le repli de `t()` quand une chaîne
 * manque en anglais) : ce sont deux rôles distincts, et seul le second change
 * ici. Une personne qui a déjà choisi sa langue garde son choix, il vit dans
 * `localStorage` (`ohb:locale`).
 */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Le dictionnaire de RÉFÉRENCE, distinct du défaut ci-dessus.
 *
 * `messages.fr.ts` est le fichier dont les clés font foi (`MessageKey` en est
 * dérivé) et celui sur lequel `t()` retombe quand une chaîne manque ailleurs,
 * comme l'exige US-I18N-01. Ce rôle n'a rien à voir avec « la langue servie
 * par défaut » : confondre les deux ferait qu'en basculant le défaut on
 * changerait aussi la langue de secours, et une clé manquante en anglais
 * retomberait sur elle-même au lieu du français.
 */
export const FALLBACK_LOCALE: Locale = "fr";
export const LOCALES: readonly Locale[] = ["fr", "en"];

/**
 * Détecte la locale depuis une chaîne BCP-47 (`navigator.language`, locale
 * Expo, `Accept-Language`…). Le produit ne parle que deux langues : toute
 * autre déclaration (`de-DE`, `es-ES`) retombe sur `DEFAULT_LOCALE`, donc
 * l'anglais, et non sur le dictionnaire de référence.
 */
export function detectLocale(source: string | null | undefined): Locale {
  if (!source) return DEFAULT_LOCALE;
  const lower = source.toLowerCase();
  if (lower.startsWith("en")) return "en";
  if (lower.startsWith("fr")) return "fr";
  return DEFAULT_LOCALE;
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Coerce toute entrée vers une locale valide, repli sur la langue par défaut. */
export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
