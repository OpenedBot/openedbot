import { OHB_SUPPORT_DISCORD_URL } from "../../discord";
import type { EmailBlock, EmailDocument } from "../design";
import { type AccessTier, isAccessTier, type TransactionalEmailKind, type TransactionalEmailLocale } from "@openedbot/contracts-api";

/**
 * Un gabarit déclare ce que le message DIT : un objet, une ligne de
 * prévisualisation, une suite de blocs, et la raison pour laquelle cette
 * personne le reçoit. Il ne décide de rien du dessin, qui vit tout entier
 * dans `design.ts` : une carte de la console, sur son fond gris.
 *
 * Le HTML et le texte brut sortent tous deux de la même liste de blocs : il
 * n'y a pas deux versions du message à tenir en phase.
 */
export type Template = (data: Record<string, unknown>) => Omit<EmailDocument, "locale">;

/**
 * Les liens légaux ne sont posés que si le producteur a mis l'origine de la
 * PWA dans la charge utile : le worker ne devine pas une URL publique, et un
 * pied de page sans lien vaut mieux qu'un lien vers un domaine inventé.
 */
/**
 * Le bandeau de la liste d'attente : l'artwork de l'écran public, en tête du
 * message. Il vit dans `public/email/` de la SPA, donc à une URL STABLE que
 * Vite ne hache pas ; voir le README de ce dossier pour la raison et pour la
 * recette de fabrication.
 *
 * TOUS les messages de la liste d'attente le portent, y compris ceux qui
 * annoncent une mauvaise nouvelle : c'est la même personne, la même histoire,
 * et un message soudain nu se lirait comme un message d'un autre expéditeur.
 *
 * Sans origine publique connue, pas de bandeau : une balise `img` pointant
 * vers une URL relative ne s'affiche nulle part dans un client de messagerie,
 * et un cadre vide vaut moins que rien.
 */
export function waitlistBanner(data: Record<string, unknown>, alt: string): EmailBlock[] {
  const base = text(data.webAppUrl).replace(/\/+$/, "");
  if (!base) return [];
  return [{ kind: "image", url: `${base}/email/waitlist-banner.jpg`, alt, width: 440, height: 213 }];
}

/**
 * Le bouton d'entrée, posé seulement si l'origine de la PWA est connue : la
 * même discipline que le bandeau, pour la même raison. Un message sans bouton
 * reste lisible ; un bouton vers un domaine inventé, non.
 */
export function loginButton(data: Record<string, unknown>, label: string): EmailBlock[] {
  const base = text(data.webAppUrl).replace(/\/+$/, "");
  if (!base) return [];
  return [{ kind: "button", label, url: `${base}/login` }];
}

/**
 * Le passage support : une phrase, puis un bouton vers le Discord. Ni
 * `paragraph` ni `note` ne rendent de lien cliquable (`design.ts` n'échappe
 * que du texte) : le bouton est le seul bloc du vocabulaire qui pose un vrai
 * `<a href>`, et `safeUrl` n'interdit aucune origine externe. Contrairement au
 * bandeau et au bouton de connexion, il ne dépend pas de `webAppUrl` : le
 * Discord est une adresse fixe, jamais un domaine à deviner.
 */
export function discordSupportBlocks(paragraphText: string, buttonLabel: string): EmailBlock[] {
  return [
    { kind: "paragraph", text: paragraphText },
    { kind: "button", label: buttonLabel, url: OHB_SUPPORT_DISCORD_URL },
  ];
}

/**
 * Le mode d'accès, dans la langue de la personne. L'identifiant technique
 * (`alpha`, `beta`, `classic`) ne sort jamais tel quel dans un message : c'est
 * une valeur de colonne, pas un mot. Un mode inconnu, ou absent de la charge
 * utile, retombe sur un mot NEUTRE plutôt que sur une chaîne vide au milieu
 * d'une phrase.
 */
export function accessTierLabel(value: unknown, locale: TransactionalEmailLocale): string {
  const labels: Record<AccessTier, Record<TransactionalEmailLocale, string>> = {
    alpha: { fr: "Alpha", en: "Alpha" },
    beta: { fr: "Bêta", en: "Beta" },
    classic: { fr: "Classique", en: "Classic" },
  };
  // Le mot neutre est le même dans les deux langues : il ne nomme aucun mode.
  return isAccessTier(value) ? labels[value][locale] : "standard";
}

export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Une heure lisible par le destinataire : celle de Paris en français (le
 * produit et ses opérateurs y sont ; une heure UTC nue se lisait avec deux
 * heures de décalage), UTC nommé en anglais, faute de fuseau connu.
 */
export function formatTime(iso: string, locale: "fr" | "en"): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return iso;
  if (locale === "en") return `${date.toISOString().slice(11, 16)} UTC`;
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(date);
}

/** Les gabarits d'une famille de messages : une partie de `TEMPLATES`, toutes langues. */
export type TemplateFamily = Partial<Record<TransactionalEmailKind, Record<TransactionalEmailLocale, Template>>>;
