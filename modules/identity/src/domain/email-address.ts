/**
 * La forme d'une adresse e-mail, et rien d'autre.
 *
 * Ce module est ISOMORPHE : la PWA s'en sert pour dire tout de suite « il
 * manque un @ », l'API pour refuser avant d'écrire. Les deux appliquent donc
 * exactement la même règle, ce qui évite le pire des messages d'erreur, celui
 * qui apparaît après la requête pour une raison que le champ ne montrait pas.
 *
 * Ce qu'il ne fait PAS, délibérément :
 *
 * - il ne dit pas si le domaine existe (c'est le DNS, côté API seulement) ;
 * - il ne dit pas si le domaine est jetable (c'est une liste, côté API
 *   seulement : embarquer trois mille domaines dans le bundle du navigateur
 *   pour un refus que le serveur doit de toute façon reprononcer serait payer
 *   deux fois pour rien).
 *
 * La règle est plus stricte que la RFC 5322, et c'est voulu. La RFC autorise
 * les commentaires, les guillemets, les adresses IP littérales et un domaine
 * sans point : `a@b` est une adresse valide au sens de la norme, et n'est
 * jamais ce qu'une personne a voulu taper dans un formulaire d'inscription.
 * On exige donc un domaine nommé, avec au moins un point et une extension
 * alphabétique.
 */

/** Bornes de la norme : 64 octets pour la partie locale, 255 pour le domaine, 320 en tout. */
const MAX_LOCAL = 64;
const MAX_DOMAIN = 255;
export const MAX_EMAIL_LENGTH = 320;

/** Les caractères que la RFC autorise sans guillemets, `.` traité à part. */
const LOCAL_ATOM = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+$/u;
/** Une étiquette de domaine : lettres, chiffres et tirets, jamais en bordure. */
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
/** L'extension : au moins deux lettres, jamais un chiffre (pas d'IP littérale). */
const TOP_LEVEL = /^[a-z]{2,}$/u;

/**
 * Met une saisie sous sa forme canonique : sans espaces autour, en
 * minuscules. C'est cette valeur qui est stockée et comparée, pour qu'une
 * même personne ne s'inscrive pas deux fois en changeant la casse.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * `true` si la forme est celle d'une adresse qu'un humain a voulu taper.
 * Attend une valeur déjà normalisée ; normalise sinon.
 */
export function isEmailSyntaxValid(raw: string): boolean {
  const value = normalizeEmail(raw);
  if (value.length < 6 || value.length > MAX_EMAIL_LENGTH) return false;
  if (/\s/u.test(value)) return false;

  const at = value.lastIndexOf("@");
  if (at < 1 || at !== value.indexOf("@")) return false;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return isLocalPartValid(local) && isDomainValid(domain);
}

function isLocalPartValid(local: string): boolean {
  if (local.length < 1 || local.length > MAX_LOCAL) return false;
  // Un point sépare des atomes : ni en bordure, ni doublé.
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return local.split(".").every((atom) => LOCAL_ATOM.test(atom));
}

/**
 * Un domaine nommé : au moins deux étiquettes, chacune valide, une extension
 * alphabétique. `localhost`, `a@b` et `1.2.3.4` sont refusés ici, avant même
 * que le DNS soit consulté.
 */
export function isDomainValid(domain: string): boolean {
  if (domain.length < 4 || domain.length > MAX_DOMAIN) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => label.length <= 63 && DOMAIN_LABEL.test(label))) return false;
  return TOP_LEVEL.test(labels[labels.length - 1]!);
}

/** Le domaine d'une adresse déjà validée ; chaîne vide si elle ne l'est pas. */
export function emailDomain(raw: string): string {
  const value = normalizeEmail(raw);
  const at = value.lastIndexOf("@");
  return at > 0 ? value.slice(at + 1) : "";
}
