/**
 * Un UUID v4, y compris hors contexte sécurisé.
 *
 * `crypto.randomUUID` est marqué `[SecureContext]` : il n'existe qu'en `https`,
 * `localhost` ou `127.0.0.1`. Ouvrir la PWA depuis le LAN (`http://192.168.x.x`)
 * le fait disparaître, et chaque appel nu jetait un `TypeError` au moment
 * d'envoyer un message. `crypto.getRandomValues`, lui, reste exposé partout.
 *
 * Le format n'est pas cosmétique : l'API valide la clé d'idempotence contre
 * `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`
 * et refuse en 400 tout ce qui n'est pas un UUID RFC 4122 canonique. D'où les
 * bits de version et de variant forcés à la main.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
