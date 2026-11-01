import { createHash } from "node:crypto";
import type { AuthFailureCode, AuthStartDto } from "@openedbot/contracts-api";
import type { LinkOptions, NativeGoogleCompletion, NativeOptions, OAuthAttemptStore } from "../sql/oauth-attempt-store";

export type GoogleIdentity = { subject: string; email: string; displayName: string | null };

/** Ce que l'authentification Google lit de la configuration de l'API. */
export type GoogleAuthConfig = {
  google: { clientId: string | null; clientSecret: string | null; allowedEmails: ReadonlySet<string> };
  webOrigins: string[];
  publicUrl: string;
};

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const TTL_MS = 10 * 60_000;
let jwksCache: { expiresAt: number; keys: Map<string, JsonWebKey> } | null = null;

export function createGoogleAuth(config: GoogleAuthConfig, attempts: OAuthAttemptStore) {
  const random = (bytes = 32) => crypto.getRandomValues(new Uint8Array(bytes)).reduce((value, byte) => value + byte.toString(16).padStart(2, "0"), "");
  const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

  return {
    enabled: Boolean(config.google.clientId && config.google.clientSecret),
    async start(returnTo?: string | null, native: NativeOptions | null = null, link: LinkOptions | null = null): Promise<AuthStartDto> {
      if (!config.google.clientId || !config.google.clientSecret) throw new Error("Google OAuth is not configured.");
      let safeReturnTo: string | null = null;
      if (returnTo) {
        try { const parsed = new URL(returnTo); if (config.webOrigins.includes(parsed.origin)) safeReturnTo = parsed.toString(); } catch { safeReturnTo = null; }
      }
      const attempt = { id: random(), state: random(), nonce: random(), verifier: random(48) };
      const redirectUri = `${config.publicUrl}/api/auth/google/callback`;
      await attempts.create({
        attemptId: attempt.id,
        state: attempt.state,
        nonce: attempt.nonce,
        verifier: attempt.verifier,
        returnTo: safeReturnTo,
        native,
        link,
        expiresAt: new Date(Date.now() + TTL_MS),
      });
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", config.google.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("state", attempt.state);
      url.searchParams.set("nonce", attempt.nonce);
      url.searchParams.set("code_challenge", sha256(attempt.verifier));
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("prompt", "select_account");
      return { attemptId: attempt.id, authorizeUrl: url.toString() };
    },
    async callback(params: URLSearchParams): Promise<{ ok: true; attemptId: string; identity: GoogleIdentity; returnTo: string | null; native: boolean; link: LinkOptions | null } | { ok: false; attemptId: string | null; code: AuthFailureCode; returnTo: string | null }> {
      const state = params.get("state");
      if (!state) return { ok: false, attemptId: null, code: "AUTH_STATE_INVALID", returnTo: null };
      const begun = await attempts.beginCallback(state);
      if (!begun.ok) return { ok: false, attemptId: null, code: "AUTH_STATE_INVALID", returnTo: begun.returnTo };
      const attempt = begun.attempt;
      if (params.get("error")) {
        await attempts.fail(attempt.attemptId, "AUTH_DENIED");
        return { ok: false, attemptId: attempt.attemptId, code: "AUTH_DENIED", returnTo: attempt.returnTo };
      }
      const code = params.get("code");
      if (!code || !config.google.clientId || !config.google.clientSecret) {
        await attempts.fail(attempt.attemptId, "AUTH_EXCHANGE_FAILED");
        return { ok: false, attemptId: attempt.attemptId, code: "AUTH_EXCHANGE_FAILED", returnTo: attempt.returnTo };
      }
      let body: { id_token?: string };
      try {
        const response = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: `${config.publicUrl}/api/auth/google/callback`, grant_type: "authorization_code", code_verifier: attempt.verifier }), signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error("exchange");
        body = await response.json() as { id_token?: string };
      } catch {
        await attempts.fail(attempt.attemptId, "AUTH_EXCHANGE_FAILED");
        return { ok: false, attemptId: attempt.attemptId, code: "AUTH_EXCHANGE_FAILED", returnTo: attempt.returnTo };
      }
      const identity = await verifyIdToken(body.id_token ?? "", config, attempt.nonce);
      if (!identity.ok) {
        await attempts.fail(attempt.attemptId, identity.code);
        return { ok: false, attemptId: attempt.attemptId, code: identity.code, returnTo: attempt.returnTo };
      }
      return { ok: true, attemptId: attempt.attemptId, identity: identity.value, returnTo: attempt.returnTo, native: Boolean(attempt.native), link: attempt.link };
    },
    /**
     * Google a dit oui, la suite a dit non. Sans ce nom posé sur la tentative,
     * le client resterait à sonder `claim` indéfiniment sur un `pending` qui ne
     * changera plus.
     */
    failAttempt(attemptId: string, code: AuthFailureCode): Promise<void> {
      return attempts.fail(attemptId, code);
    },
    completeWeb(attemptId: string, user: { email: string; displayName: string | null }): Promise<void> {
      return attempts.completeWeb(attemptId, user);
    },
    completeNative(attemptId: string, completion: NativeGoogleCompletion): Promise<void> {
      return attempts.completeNative(attemptId, completion);
    },
    claim(attemptId: string) {
      return attempts.claimWeb(attemptId);
    },
    claimNative(attemptId: string, verifier: string, redirectUri: string) {
      return attempts.claimNative(attemptId, verifier, redirectUri);
    },
    completeLink(attemptId: string): Promise<void> {
      return attempts.completeLink(attemptId);
    },
    claimLink(attemptId: string, userId: string) {
      return attempts.claimLink(attemptId, userId);
    },
  };
}

export type GoogleAuth = ReturnType<typeof createGoogleAuth>;

async function verifyIdToken(token: string, config: GoogleAuthConfig, nonce: string): Promise<{ ok: true; value: GoogleIdentity } | { ok: false; code: AuthFailureCode }> {
  const parts = token.split(".");
  if (parts.length !== 3 || !config.google.clientId) return { ok: false, code: "AUTH_TOKEN_INVALID" };
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>; } catch { return { ok: false, code: "AUTH_TOKEN_INVALID" }; }
  try { header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as Record<string, unknown>; } catch { return { ok: false, code: "AUTH_TOKEN_INVALID" }; }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !(await verifyGoogleSignature(parts, header.kid))) {
    return { ok: false, code: "AUTH_TOKEN_INVALID" };
  }
  if (!GOOGLE_ISSUERS.has(String(claims.iss)) || claims.aud !== config.google.clientId || claims.nonce !== nonce || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return { ok: false, code: "AUTH_TOKEN_INVALID" };
  const verified = claims.email_verified === true || claims.email_verified === "true";
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  if (!verified) return { ok: false, code: "AUTH_EMAIL_NOT_VERIFIED" };
  if (!subject || !email) return { ok: false, code: "AUTH_TOKEN_INVALID" };
  if (config.google.allowedEmails.size > 0 && !config.google.allowedEmails.has(email)) return { ok: false, code: "AUTH_EMAIL_NOT_ALLOWED" };
  return { ok: true, value: { subject, email, displayName: typeof claims.name === "string" ? claims.name : null } };
}

async function verifyGoogleSignature(parts: string[], keyId: string): Promise<boolean> {
  try {
    const keys = await googleJwks();
    const jwk = keys.get(keyId);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signature = base64UrlBytes(parts[2]!);
    const payload = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    return crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      signature.buffer as ArrayBuffer,
      payload.buffer as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

async function googleJwks(): Promise<Map<string, JsonWebKey>> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch(GOOGLE_JWKS_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Google JWKS returned ${response.status}.`);
  const body = await response.json() as { keys?: Array<JsonWebKey & { kid?: string }> };
  const keys = new Map<string, JsonWebKey>();
  for (const key of body.keys ?? []) if (key.kid) keys.set(key.kid, key);
  if (keys.size === 0) throw new Error("Google JWKS contained no usable keys.");
  jwksCache = { expiresAt: Date.now() + 5 * 60_000, keys };
  return keys;
}

function base64UrlBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}
