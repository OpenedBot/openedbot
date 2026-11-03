import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Leaf shared by the webhook ingress and management routers. */

// The strict RFC 4122 grammar shared by the whole repository (`@openedbot/contracts-primitives`).
export { UUID_STRICT_RE as UUID } from "@openedbot/contracts-primitives";

export function createWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function hashWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function webhookSecretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashWebhookSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
