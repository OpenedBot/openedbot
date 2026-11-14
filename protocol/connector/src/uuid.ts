/**
 * Vendored from openedbot `contracts/primitives` so this package builds on its
 * own. Canonical 8-4-4-4-12 hexadecimal form, version and variant not checked.
 */
export const UUID_LOOSE_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const UUID_LOOSE_RE = new RegExp(`^${UUID_LOOSE_BODY}$`, "i");

export function isUuid(value: string): boolean {
  return UUID_LOOSE_RE.test(value);
}
