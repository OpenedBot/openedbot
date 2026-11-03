/**
 * Forme canonique d'un UUID, sans ancre ni drapeau : de quoi composer un motif
 * plus long (une clé d'objet `org/<uuid>/<uuid>`).
 */
export const UUID_LOOSE_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Idem, mais version `[1-8]` et variante `[89ab]` (RFC 9562), comme ce que
 * produisent `crypto.randomUUID` et les UUID v7.
 */
export const UUID_STRICT_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** Seulement la forme 8-4-4-4-12 en hexadécimal, sans regarder version ni variante. */
export const UUID_LOOSE_RE = new RegExp(`^${UUID_LOOSE_BODY}$`, "i");

/** La forme 8-4-4-4-12 avec version `[1-8]` et variante `[89ab]`. */
export const UUID_STRICT_RE = new RegExp(`^${UUID_STRICT_BODY}$`, "i");

export function isUuid(value: string): boolean {
  return UUID_LOOSE_RE.test(value);
}

export function isStrictUuid(value: string): boolean {
  return UUID_STRICT_RE.test(value);
}
