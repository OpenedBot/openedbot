/**
 * A UUID v4, including outside a secure context.
 *
 * `crypto.randomUUID` is marked `[SecureContext]`: it exists only on `https`,
 * `localhost` or `127.0.0.1`. Opening the PWA from the LAN (`http://192.168.x.x`)
 * makes it disappear, and each bare call threw a `TypeError` at the moment
 * of sending a message. `crypto.getRandomValues`, though, stays exposed everywhere.
 *
 * The format is not cosmetic: the API validates the idempotency key against
 * `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`
 * and refuses with 400 anything that is not a canonical RFC 4122 UUID. Hence the
 * version and variant bits forced by hand.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
