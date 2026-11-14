/**
 * Un tableau JS en littéral `text[]` Postgres (`{"a","b"}`, `{}` vide).
 *
 * Mesuré sur Bun 1.3.14 : un tableau JS lié tel quel part comme la chaîne
 * `a,b` et Postgres refuse « malformed array literal ». Le littéral, casté
 * `::text[]` dans la requête, est ce que le serveur sait relire. Chaque
 * élément est cité, antislash et guillemet échappés.
 */
export function pgTextArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;
}
