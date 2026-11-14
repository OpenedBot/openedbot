import type { EmailBlock, EmailDocument } from "../design";
import { type TransactionalEmailKind, type TransactionalEmailLocale } from "@openedbot/contracts-api";

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
 * Le bouton d'entrée, posé seulement si l'origine de la PWA est connue : la
 * même discipline que les liens légaux, pour la même raison. Un message sans bouton
 * reste lisible ; un bouton vers un domaine inventé, non.
 */
export function loginButton(data: Record<string, unknown>, label: string): EmailBlock[] {
  const base = text(data.webAppUrl).replace(/\/+$/, "");
  if (!base) return [];
  return [{ kind: "button", label, url: `${base}/login` }];
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
