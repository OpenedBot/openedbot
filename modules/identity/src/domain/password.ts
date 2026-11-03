/**
 * Règle de mot de passe : la règle de forme, partagée.
 *
 * Une seule implémentation : l'API l'applique pour trancher
 * (`account-security-routes.ts`, `auth.ts` pour `/register`), le client s'en
 * sert pour désactiver le bouton avant même d'envoyer la requête.
 */
export const PASSWORD_MIN_LENGTH = 12; // même seuil que /register, auth.ts
export const PASSWORD_MAX_LENGTH = 1024; // même plafond, auth.ts

/**
 * « Caractère spécial » = tout ce qui n'est ni une lettre ASCII ni un chiffre,
 * espace compris. Une liste fermée de ponctuations rejetterait `é`, `€` ou un
 * espace là où l'entropie, elle, est bien présente.
 */
const SYMBOL = /[^A-Za-z0-9]/u;
const UPPERCASE = /\p{Lu}/u;

export type PasswordProblem = "too_short" | "too_long" | "no_uppercase" | "no_symbol" | "unchanged";

/** Les trois exigences de forme, une par une : de quoi rendre une liste vivante pendant la frappe. */
export type PasswordChecks = { length: boolean; uppercase: boolean; symbol: boolean };

export function passwordChecks(next: string): PasswordChecks {
  return {
    length: next.length >= PASSWORD_MIN_LENGTH && next.length <= PASSWORD_MAX_LENGTH,
    uppercase: UPPERCASE.test(next),
    symbol: SYMBOL.test(next),
  };
}

/**
 * `null` si le nouveau mot de passe est acceptable, sinon pourquoi il ne
 * l'est pas. `current`, quand fourni, ne sert qu'à détecter un mot de passe
 * inchangé côté client : jamais à le vérifier (ça, c'est le hash côté API).
 *
 * La longueur reste à douze : c'est le seuil déjà en vigueur, et une règle de
 * mot de passe ne se desserre pas pour faire de la place à une autre. La
 * majuscule et le caractère spécial s'ajoutent par-dessus.
 */
export function passwordProblem(next: string, current?: string): PasswordProblem | null {
  if (next.length < PASSWORD_MIN_LENGTH) return "too_short";
  if (next.length > PASSWORD_MAX_LENGTH) return "too_long";
  if (!UPPERCASE.test(next)) return "no_uppercase";
  if (!SYMBOL.test(next)) return "no_symbol";
  if (current !== undefined && next === current) return "unchanged";
  return null;
}

/**
 * L'alphabet du mot de passe temporaire : ni `I`, ni `l`, ni `O`, ni `0`, ni
 * `1`, et pas de `i` minuscule non plus, qui redeviendrait un `I` ambigu une
 * fois mis en capitale. Ce mot de passe se lit à voix haute, se recopie d'un
 * écran à l'autre et se dicte au téléphone : deux caractères qui se
 * ressemblent y coûtent une tentative de connexion ratée, pas un bit
 * d'entropie.
 */
const TEMPORARY_UPPERCASE = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const TEMPORARY_ALPHABET = `${TEMPORARY_UPPERCASE}abcdefghjkmnpqrstuvwxyz23456789`;
const TEMPORARY_GROUPS = 4;
const TEMPORARY_GROUP_LENGTH = 4;

/**
 * Un mot de passe temporaire, fabriqué au hasard de la source cryptographique
 * de la plateforme (`crypto.getRandomValues`, présente côté Bun comme côté
 * navigateur : ce module est isomorphe).
 *
 * Sa forme (quatre groupes de quatre séparés par des tirets) satisfait
 * `passwordProblem` PAR CONSTRUCTION : dix-neuf caractères, un premier
 * caractère tiré parmi les capitales, et le tiret comme caractère spécial. Le
 * test le vérifie plutôt que de le supposer, parce qu'une règle de mot de
 * passe qui se durcit un jour doit faire échouer ce générateur ici, et non
 * chez la personne qui essaie de se connecter.
 *
 * Le tirage est UNIFORME : `% alphabet.length` sur un octet introduirait un
 * biais vers le début de l'alphabet, donc les octets hors du dernier multiple
 * complet de la taille demandée sont redemandés.
 */
export function generateTemporaryPassword(): string {
  const buffer = new Uint8Array(32);
  let cursor = buffer.length;
  const pick = (alphabet: string): string => {
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;
    for (;;) {
      if (cursor >= buffer.length) {
        crypto.getRandomValues(buffer);
        cursor = 0;
      }
      const byte = buffer[cursor] ?? 0;
      cursor += 1;
      if (byte < limit) return alphabet[byte % alphabet.length] as string;
    }
  };
  // La capitale ne se tire pas au sort dans l'alphabet complet : un tirage sur
  // trois cents sortirait sinon un mot de passe sans majuscule, que l'API
  // refuserait ensuite d'enregistrer.
  const characters = [pick(TEMPORARY_UPPERCASE)];
  for (let index = 1; index < TEMPORARY_GROUPS * TEMPORARY_GROUP_LENGTH; index += 1) {
    characters.push(pick(TEMPORARY_ALPHABET));
  }
  const groups: string[] = [];
  for (let index = 0; index < TEMPORARY_GROUPS; index += 1) {
    groups.push(characters.slice(index * TEMPORARY_GROUP_LENGTH, (index + 1) * TEMPORARY_GROUP_LENGTH).join(""));
  }
  return groups.join("-");
}
