import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Les secrets portés par une requête (jeton de lien, ticket d'enrôlement,
 * session) ne sont jamais stockés en clair : `withCredential` reçoit leur
 * empreinte. Partagé par l'API, la passerelle du lien et les modules.
 */
export function hashCredential(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomCredential(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return createHash("sha256").update(verifier).digest("base64url");
}
