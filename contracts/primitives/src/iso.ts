/** Un `Date` ou une chaîne datée en ISO 8601 ; lève `RangeError` si la chaîne n'est pas une date. */
export function isoInstant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Comme `isoInstant`, mais une chaîne qui n'est pas une date est rendue telle quelle. */
export function isoInstantLenient(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toISOString();
}

/** `null` pour toute valeur fausse (`null`, chaîne vide), sinon `isoInstant`. */
export function isoOrNull(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** `null` seulement pour `null` : une chaîne vide passe par `new Date("")` et lève. */
export function isoUnlessNull(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
