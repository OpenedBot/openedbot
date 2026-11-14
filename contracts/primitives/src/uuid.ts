/**
 * Canonical form of a UUID, with no anchor and no flag: enough to compose a longer
 * pattern (an object key `org/<uuid>/<uuid>`).
 */
export const UUID_LOOSE_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The same, but version `[1-8]` and variant `[89ab]` (RFC 9562), like what
 * `crypto.randomUUID` and v7 UUIDs produce.
 */
export const UUID_STRICT_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** Only the 8-4-4-4-12 hexadecimal form, without looking at version or variant. */
export const UUID_LOOSE_RE = new RegExp(`^${UUID_LOOSE_BODY}$`, "i");

/** The 8-4-4-4-12 form with version `[1-8]` and variant `[89ab]`. */
export const UUID_STRICT_RE = new RegExp(`^${UUID_STRICT_BODY}$`, "i");

export function isUuid(value: string): boolean {
  return UUID_LOOSE_RE.test(value);
}

export function isStrictUuid(value: string): boolean {
  return UUID_STRICT_RE.test(value);
}
